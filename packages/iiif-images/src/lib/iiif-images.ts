import {
  images,
  readImageService,
  type ImageService,
  type PaintedImage,
} from '@lde/iiif-image';
import { createHostLimiter } from '@lde/host-limiter';
import {
  fetchPublic,
  RefusedUrlError,
  ResponseTooLargeError,
} from '@lde/public-fetch';
import {
  createResolver,
  parseRetryAfter,
  RetryableError,
  sqliteFactStore,
  urlHost,
  type Resolution,
  type ResolutionFailure,
  type Resolver,
  type ResolveOptions,
} from '@lde/resolver';
import type {
  RootType,
  SearchField,
  SearchSchema,
  SearchType,
} from '@lde/search';
import { fieldNamed, irAlias, referenceTypeNamed } from '@lde/search/adapter';
import type { Quad, Quad_Object, Quad_Subject } from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import {
  iiifImage,
  iiifImageService,
  iiifImageSize,
  representativeImageField,
} from '../schema.js';

export interface IiifImagesOptions {
  /**
   * The SQLite file resolved facts live in between runs. It has to survive the
   * run: the search index is rebuilt from it, and nothing else holds these facts.
   */
  readonly storePath: string;
  /**
   * How long after this object’s construction it may still start fetching, in
   * milliseconds, across all datasets, so construct one per run. Unset, there is
   * no limit: everything is fetched as fast as the publishers allow.
   *
   * What the window defers is counted, as `manifests deferred` or
   * `image services deferred`, but not reported, and those works are indexed
   * without an image until a later run fetches it.
   */
  readonly fetchWindowMs?: number;
  /** Told about each reference that failed. Defaults to a console warning. */
  readonly report?: (failure: ResolutionFailure) => void;
}

/** What the transform reads from the reader it is attached to. */
export interface IiifImagesContext {
  /**
   * Told what became of each manifest and image service, such as
   * `manifests fetched` or `image services from store`, so the stage can add
   * up the run. An `@lde/pipeline` reader passes its own.
   */
  readonly count?: (name: string) => void;
}

/** A transform attachable to a reader as an `@lde/pipeline` `QuadTransform`. */
export type IiifImagesTransform = (
  quads: AsyncIterable<Quad>,
  context: IiifImagesContext,
) => AsyncIterable<Quad>;

export interface IiifImages {
  /**
   * The transform to attach to a root type’s reader, after any transform that
   * repairs IRIs, or `undefined` where that type does not declare
   * `representativeImage` and `associatedMedia` – so a deployment on an older
   * schema loses the enrichment rather than the run.
   */
  transformFor(rootType: RootType): IiifImagesTransform | undefined;
  /** Throws when the store cannot persist, to fail a run before it starts. */
  check(): Promise<void>;
}

/**
 * Enrich works with the image that represents them: its URL and dimensions, and
 * for an image with an image service, a ladder of precomputed sizes, resolved
 * from the work’s IIIF Presentation manifest and the selected image’s
 * `info.json`. A static image is read from the manifest alone.
 *
 * A work with no manifest, or whose resolution has not succeeded, gets no
 * `representativeImage`; consumers then fall back to the `thumbnailUrl` already
 * in `associatedMedia`, and a failed resolution is retried on a later run.
 */
export function iiifImages(
  schema: SearchSchema,
  options: IiifImagesOptions,
): IiifImages {
  const limits =
    options.fetchWindowMs === undefined
      ? {}
      : { fetchWindowMs: options.fetchWindowMs };
  const report =
    options.report ??
    ((failure) => console.warn(`${failure.key}: ${failure.reason}`));

  // One limiter for both, so a host serving manifests and image services alike
  // gets one limit: 4 batches against a host, as each resolver had on its own.
  const limiter = createHostLimiter(8, 4);
  const manifests: Resolver<string, ManifestFact> = createResolver({
    key: (manifest) => manifest,
    host: manifestHost,
    limiter,
    fetch: (manifests, { signal }) =>
      fetchFacts(
        manifests,
        (url) => url,
        (document) => {
          try {
            return usable(images(document));
          } catch (error) {
            // A document that says it is a collection, or a manifest too broken
            // to read, has no image to offer: a fact about that document. Anything
            // else – an error page served as JSON – is a server misbehaving, so
            // no absence may overwrite the stored fact.
            if (error instanceof TypeError && declaresIiifType(document)) {
              return undefined;
            }
            throw error;
          }
        },
        signal,
        report,
      ),
    store: sqliteFactStore<ManifestFact>({
      path: options.storePath,
      table: 'manifests',
    }),
    // 2: the selected image rather than its service’s URL, and static images too.
    // Facts now hold a list of images; one stored as a single image still reads,
    // as a list of one, so the store isn’t refetched all at once.
    version: '2',
    limits: { ...limits, ttlMs: MANIFEST_TTL_MS },
    report,
  });
  const services: Resolver<string, ImageService> = createResolver({
    key: (service) => service,
    host: urlHost,
    limiter,
    fetch: (services, { signal }) =>
      fetchFacts(
        services,
        (service) => `${service}/info.json`,
        (info, service) => {
          // Same reasoning, with more at stake: these facts are otherwise permanent.
          const fact = readImageService(service, info);
          if (fact === undefined) {
            throw new Error(`${service}/info.json states no dimensions`);
          }
          return fact;
        },
        signal,
        report,
      ),
    store: sqliteFactStore<ImageService>({
      path: options.storePath,
      table: 'images',
    }),
    limits: { ...limits, ttlMs: IMAGE_TTL_MS },
    report,
  });

  return {
    transformFor(rootType) {
      const aliases = aliasesOf(rootType, schema);
      return aliases === undefined
        ? undefined
        : async function* enrich(quads, context) {
            // A batch of roots is the unit of work and what bounds the memory: a
            // work’s manifest entry is only known once the batch is, and resolving
            // per batch is what lets the resolver share one store read.
            const batch: Quad[] = [];
            for await (const quad of quads) {
              batch.push(quad);
              yield quad;
            }
            const manifestOfWork = manifestsIn(batch, aliases);
            const selected = await manifests.resolveAll(
              [...manifestOfWork.values()],
              countedAs('manifests', context),
            );
            const imagesOfWork = new Map<string, readonly PaintedImage[]>();
            for (const [work, manifest] of manifestOfWork) {
              const resolution = selected.get(manifest);
              if (resolution?.outcome === 'resolved') {
                imagesOfWork.set(work, [resolution.fact].flat());
              }
            }
            const representatives = await representativesOf(
              imagesOfWork,
              services,
              countedAs('image services', context),
            );
            for (const [work, representative] of representatives) {
              yield* mint(factory.namedNode(work), representative, aliases);
            }
          };
    },
    async check() {
      await manifests.check();
      await services.check();
    },
  };
}

const factory = new DataFactory();

/** Pass the resolver’s counts on to the context, prefixed with what is resolved. */
function countedAs(
  prefix: string,
  { count }: IiifImagesContext,
): ResolveOptions {
  return { count: (name) => count?.(`${prefix} ${name}`) };
}

const INTEGER = factory.namedNode('http://www.w3.org/2001/XMLSchema#integer');
/** What the profile’s `encodingFormat` for a manifest entry contains. */
const IIIF_PRESENTATION_CONTEXT = 'iiif.io/api/presentation';
/** A manifest’s selection can change, so it is reconsidered after 30 days. */
const MANIFEST_TTL_MS = 30 * 24 * 3_600_000;
/**
 * An image’s dimensions do not change, but what its server offers does: an upgrade
 * can change the size URLs stored with them. So these facts are reconsidered too,
 * only rarely.
 */
const IMAGE_TTL_MS = 180 * 24 * 3_600_000;
const IIIF_TYPES = new Set([
  'Manifest',
  'Collection',
  'sc:Manifest',
  'sc:Collection',
]);
/** Answers meaning this document is not ours to have, now or on a retry. */
const ABSENT_STATUSES = new Set([401, 403, 404, 410]);
/**
 * How many of a manifest’s usable images are kept, in case the first is gone. A
 * digitised book can paint hundreds; a work whose first ten are all gone has a
 * problem a fallback should not hide.
 */
const CANDIDATES = 10;

/**
 * The server a manifest is fetched from, which its limit and failure cut-off are
 * kept for: the URL’s host. An ARK on `n2t.net` is the exception, because that
 * host only redirects; its NAAN, which belongs to one organisation, stands in for
 * the server at the end of the redirects, so organisations are not lumped
 * together.
 */
function manifestHost(manifest: string): string {
  if (!URL.canParse(manifest)) {
    return manifest;
  }
  const { host, pathname } = new URL(manifest);
  // The `ark:` label is case-insensitive.
  const naan =
    host === 'n2t.net' ? /^\/ark:\/?([^/]+)/i.exec(pathname)?.[1] : undefined;
  return naan === undefined ? host : `${host}/ark:/${naan}`;
}

/**
 * A manifest’s usable images, in order. A single image is a fact stored before
 * the list was kept, until its TTL has it refetched.
 */
type ManifestFact = PaintedImage | readonly PaintedImage[];

/** What is minted for a work. A static image has no sizes and no service. */
interface RepresentativeImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sizes: ImageService['sizes'];
  readonly service?: string;
}

/**
 * The first {@link CANDIDATES} distinct images that can represent the work, in
 * manifest order, or `undefined` for none: images with an image service, whose
 * `info.json` states their dimensions, or static images whose manifest states
 * them. Without a size to state, a static image adds nothing to the
 * `thumbnailUrl` consumers already have. Its URL is minted as an IRI, so an image
 * whose `id` is not an absolute web address is passed over. An image painted
 * again, by its service or else its URL, is passed over too: it would be gone
 * again.
 */
function usable(
  painted: Iterable<PaintedImage>,
): readonly PaintedImage[] | undefined {
  const candidates: PaintedImage[] = [];
  const seen = new Set<string>();
  for (const image of painted) {
    const url = webAddress(image.url);
    if (
      url === undefined ||
      (image.service === undefined && staticOf(image) === undefined) ||
      seen.has(image.service ?? url)
    ) {
      continue;
    }
    seen.add(image.service ?? url);
    candidates.push({ ...image, url });
    if (candidates.length === CANDIDATES) {
      break;
    }
  }
  return candidates.length === 0 ? undefined : candidates;
}

/**
 * Each work’s representative image: the first of its candidates that can stand
 * for it. A candidate whose image service is gone, with no size in the manifest
 * to fall back on, gives way to the next, whose service is only then resolved.
 * One whose service is unresolved holds its place, so a passing outage does not
 * swap a work’s image and swap it back on the next run.
 */
async function representativesOf(
  imagesOfWork: ReadonlyMap<string, readonly PaintedImage[]>,
  services: Resolver<string, ImageService>,
  options: ResolveOptions,
): Promise<Map<string, RepresentativeImage>> {
  const representatives = new Map<string, RepresentativeImage>();
  const resolved = new Map<string, Resolution<ImageService>>();
  let pending = [...imagesOfWork];
  while (pending.length > 0) {
    // A service resolved in an earlier round is not asked for, or counted, again.
    const due = pending.flatMap(([, [{ service }]]) =>
      service === undefined || resolved.has(service) ? [] : [service],
    );
    if (due.length > 0) {
      for (const entry of await services.resolveAll(due, options)) {
        resolved.set(...entry);
      }
    }
    const next: typeof pending = [];
    for (const [work, [image, ...rest]] of pending) {
      const representative = representativeOf(image, resolved);
      if (representative !== undefined) {
        representatives.set(work, representative);
      } else if (
        rest.length > 0 &&
        image.service !== undefined &&
        resolved.get(image.service)?.outcome === 'absent'
      ) {
        next.push([work, rest]);
      }
    }
    pending = next;
  }
  return representatives;
}

/**
 * The image to mint, or `undefined` while its image service is not resolved.
 * An image service found to be gone leaves the size the manifest states, if any.
 */
function representativeOf(
  image: PaintedImage,
  resolved: ReadonlyMap<string, Resolution<ImageService>>,
): RepresentativeImage | undefined {
  const resolution =
    image.service === undefined ? undefined : resolved.get(image.service);
  if (resolution?.outcome === 'resolved') {
    return { ...resolution.fact, url: image.url, service: resolution.fact.url };
  }
  return image.service === undefined || resolution?.outcome === 'absent'
    ? staticOf(image)
    : undefined;
}

/** The image as the manifest states it, without sizes or a service. */
function staticOf(image: PaintedImage): RepresentativeImage | undefined {
  return image.width === undefined || image.height === undefined
    ? undefined
    : { url: image.url, width: image.width, height: image.height, sizes: [] };
}

/** The URL, normalised, if it is an absolute `http(s)` one. */
function webAddress(url: string): string | undefined {
  if (!URL.canParse(url)) {
    return undefined;
  }
  const { protocol, href } = new URL(url);
  return protocol === 'http:' || protocol === 'https:' ? href : undefined;
}

/** The IR aliases one root type’s enrichment reads and mints under. */
interface Aliases {
  readonly associatedMedia: string;
  readonly encodingFormat: string;
  readonly representativeImage: string;
  readonly image: FieldAliases<typeof iiifImage>;
  readonly size: FieldAliases<typeof iiifImageSize>;
  readonly service: FieldAliases<typeof iiifImageService>;
}

/** Each field of a declared type, under the alias that type’s projection reads. */
type FieldAliases<
  Type extends { readonly fields: readonly { name: string }[] },
> = Readonly<Record<Type['fields'][number]['name'], string>>;

function aliasesOf(
  rootType: RootType,
  schema: SearchSchema,
): Aliases | undefined {
  const media = fieldNamed(rootType, 'associatedMedia');
  const image = fieldNamed(rootType, representativeImageField.name);
  const mediaType = referencedType(schema, media);
  const encodingFormat =
    mediaType === undefined ? undefined : aliasOf(mediaType, 'encodingFormat');
  const imageType = referencedType(schema, image);
  const sizeType =
    imageType && referencedType(schema, fieldNamed(imageType, 'sizes'));
  const serviceType =
    imageType && referencedType(schema, fieldNamed(imageType, 'service'));
  if (
    media === undefined ||
    image === undefined ||
    encodingFormat === undefined ||
    imageType === undefined ||
    sizeType === undefined ||
    serviceType === undefined
  ) {
    return undefined;
  }
  const imageAliases = fieldAliases(imageType, iiifImage);
  const sizeAliases = fieldAliases(sizeType, iiifImageSize);
  const serviceAliases = fieldAliases(serviceType, iiifImageService);
  return imageAliases === undefined ||
    sizeAliases === undefined ||
    serviceAliases === undefined
    ? undefined
    : {
        associatedMedia: irAlias(rootType, media),
        encodingFormat,
        representativeImage: irAlias(rootType, image),
        image: imageAliases,
        size: sizeAliases,
        service: serviceAliases,
      };
}

/**
 * The type a reference field nests. Read from the declaration rather than through
 * `nestedReferenceType`, which answers only for surfaced fields: a schema may read
 * `associatedMedia` without surfacing it, and should still be enriched.
 */
function referencedType(
  schema: SearchSchema,
  field: SearchField | undefined,
): SearchType | undefined {
  return field?.kind === 'reference' && field.ref?.strategy === 'inline'
    ? referenceTypeNamed(schema, field.ref.typeName)
    : undefined;
}

/** Every field `declaration` names, as the schema’s own `searchType` aliases it,
 *  or `undefined` where that type lacks one. */
function fieldAliases<
  Type extends { readonly fields: readonly { name: string }[] },
>(searchType: SearchType, declaration: Type): FieldAliases<Type> | undefined {
  const entries = declaration.fields.map(
    ({ name }) => [name, aliasOf(searchType, name)] as const,
  );
  return entries.every(([, alias]) => alias !== undefined)
    ? (Object.fromEntries(entries) as FieldAliases<Type>)
    : undefined;
}

function aliasOf(searchType: SearchType, name: string): string | undefined {
  const field = fieldNamed(searchType, name);
  return field === undefined ? undefined : irAlias(searchType, field);
}

/**
 * Each work’s manifest: its `associatedMedia` entry that is a named node and names
 * the IIIF Presentation context in its `encodingFormat`. The profile allows one;
 * where a publisher states more, the first by IRI, because quad order can change
 * between runs and the representative image should not change with it. Only works
 * named by an IRI, because the image is minted onto the work by its name.
 */
function manifestsIn(
  batch: readonly Quad[],
  aliases: Aliases,
): Map<string, string> {
  const manifestEntries = new Set(
    batch
      .filter(
        (quad) =>
          quad.predicate.value === aliases.encodingFormat &&
          quad.subject.termType === 'NamedNode' &&
          quad.object.value.includes(IIIF_PRESENTATION_CONTEXT),
      )
      .map((quad) => quad.subject.value),
  );
  const manifestOfWork = new Map<string, string>();
  for (const quad of batch) {
    if (
      quad.predicate.value !== aliases.associatedMedia ||
      quad.subject.termType !== 'NamedNode' ||
      !manifestEntries.has(quad.object.value)
    ) {
      continue;
    }
    const current = manifestOfWork.get(quad.subject.value);
    if (current === undefined || quad.object.value < current) {
      manifestOfWork.set(quad.subject.value, quad.object.value);
    }
  }
  return manifestOfWork;
}

/**
 * Fetch each key’s JSON document and derive its fact. An {@link ABSENT_STATUSES}
 * answer, or a document `derive` finds no fact in, is an absence and left out;
 * anything else throws, so the resolver retries it and a stored fact survives a
 * passing outage. Restricted images are absences so that they cannot write off a
 * host whose public images are fine. So, reported, is a URL that is not a public
 * web address – publisher data decides these URLs, and this runs inside the
 * cluster – and a document too large to read, which a retry would not shrink.
 */
async function fetchFacts<Fact>(
  keys: readonly string[],
  urlOf: (key: string) => string,
  derive: (document: unknown, key: string) => Fact | undefined,
  signal: AbortSignal,
  report: (failure: ResolutionFailure) => void,
): Promise<Array<readonly [string, Fact]>> {
  const facts: Array<readonly [string, Fact]> = [];
  for (const key of keys) {
    let document: unknown;
    try {
      document = await fetchDocument(urlOf(key), signal);
    } catch (error) {
      if (
        !(error instanceof RefusedUrlError) &&
        !(error instanceof ResponseTooLargeError)
      ) {
        throw error;
      }
      report({ key, reason: error.message, degradedToStore: false });
      continue;
    }
    const fact = document === undefined ? undefined : derive(document, key);
    if (fact !== undefined) {
      facts.push([key, fact]);
    }
  }
  return facts;
}

/** The JSON document at `url`, or `undefined` for an {@link ABSENT_STATUSES} answer. */
async function fetchDocument(
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  // Only `*/*`: LDmaX answers 404 to any JSON media type in `Accept`, IIIF’s own
  // included, even with `*/*` as a fallback beside it.
  const response = await fetchPublic(url, {
    signal,
    headers: { Accept: '*/*' },
  });
  if (!response.ok) {
    // An unread body keeps its connection until garbage collection.
    await response.body?.cancel();
    if (ABSENT_STATUSES.has(response.status)) {
      return undefined;
    }
    const retryAfter = response.headers.get('retry-after');
    // The server asked to come back later, so the resolver tries again this run
    // and pauses the host for as long as it said.
    if (
      response.status === 429 ||
      (response.status === 503 && retryAfter !== null)
    ) {
      throw new RetryableError(`${url} answered ${response.status}`, {
        retryAfterMs: parseRetryAfter(retryAfter),
      });
    }
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.json();
}

/** Whether a document says it is a IIIF manifest or collection, in Presentation 3 or 2. */
function declaresIiifType(document: unknown): boolean {
  if (typeof document !== 'object' || document === null) {
    return false;
  }
  const { type, '@type': legacyType } = document as Record<string, unknown>;
  return IIIF_TYPES.has(String(type ?? legacyType));
}

function* mint(
  work: Quad_Subject,
  fact: RepresentativeImage,
  aliases: Aliases,
): Generator<Quad> {
  const image = factory.blankNode();
  yield triple(work, aliases.representativeImage, image);
  yield triple(image, aliases.image.url, factory.namedNode(fact.url));
  yield triple(image, aliases.image.width, integer(fact.width));
  yield triple(image, aliases.image.height, integer(fact.height));
  for (const size of fact.sizes) {
    const node = factory.blankNode();
    yield triple(image, aliases.image.sizes, node);
    yield triple(node, aliases.size.width, integer(size.width));
    yield triple(node, aliases.size.height, integer(size.height));
    yield triple(node, aliases.size.url, factory.namedNode(size.url));
  }
  if (fact.service !== undefined) {
    const service = factory.blankNode();
    yield triple(image, aliases.image.service, service);
    yield triple(service, aliases.service.url, factory.namedNode(fact.service));
  }
}

function triple(
  subject: Quad_Subject,
  predicate: string,
  object: Quad_Object,
): Quad {
  return factory.quad(subject, factory.namedNode(predicate), object);
}

function integer(value: number) {
  return factory.literal(String(value), INTEGER);
}
