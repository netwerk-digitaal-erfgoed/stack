import {
  createResolver,
  sqliteFactStore,
  urlHost,
  type ResolutionFailure,
  type Resolver,
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
import { imageFactFrom, type ImageFact } from './image-service.js';
import { listsCanvases, selectImageService } from './manifest.js';

export interface IiifImagesOptions {
  /**
   * The SQLite file resolved facts live in between runs. It has to survive the
   * run: the search index is rebuilt from it, and nothing else holds these facts.
   */
  readonly storePath: string;
  /**
   * Manifests, and separately `info.json` documents, this object may fetch across
   * all datasets, so construct one per run. Defaults to the resolver’s 500.
   *
   * What the budget defers is not reported, and those works are indexed without an
   * image. A cold store then warms only as datasets are reprocessed, so where
   * unchanged datasets are skipped, set this high enough to cover them in one run.
   */
  readonly fetchesPerRun?: number;
  /** Told about each reference that failed. Defaults to a console warning. */
  readonly report?: (failure: ResolutionFailure) => void;
}

/** What the transform reads from the reader it is attached to. */
export interface IiifImagesContext {
  readonly dataset: { readonly iri: URL };
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
 * Enrich works with the image that represents them: its dimensions and a ladder
 * of precomputed sizes, resolved from the work’s IIIF Presentation manifest and
 * the selected image’s `info.json`.
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
    options.fetchesPerRun === undefined
      ? {}
      : { fetchesPerResolver: options.fetchesPerRun };
  const report =
    options.report ??
    ((failure) => console.warn(`${failure.key}: ${failure.reason}`));

  const manifests: Resolver<ManifestReference, string> = createResolver({
    key: (reference) => reference.url,
    // Not the manifest’s own host: many are on n2t.net, which only redirects, so
    // its limits and failure cut-off would land on the wrong server and lump
    // publishers together. A dataset is the closest known stand-in for the server
    // at the end of those redirects.
    host: (reference) => reference.dataset,
    fetch: (references, { signal }) =>
      fetchFacts(
        references.map(({ url }) => url),
        (url) => url,
        (document, url) => {
          // A manifest must have a canvas, so one without is a server misbehaving,
          // not a manifest with no image: an absence would overwrite the stored fact.
          if (!listsCanvases(document)) {
            throw new Error(`${url} is not a manifest with canvases`);
          }
          return selectImageService(document);
        },
        signal,
      ),
    store: sqliteFactStore<string>({
      path: options.storePath,
      table: 'manifests',
    }),
    limits: { ...limits, ttlMs: MANIFEST_TTL_MS },
    report,
  });
  const images: Resolver<string, ImageFact> = createResolver({
    key: (service) => service,
    host: urlHost,
    fetch: (services, { signal }) =>
      fetchFacts(
        services,
        (service) => `${service}/info.json`,
        (info, service) => {
          // Same reasoning, with more at stake: these facts are otherwise permanent.
          const fact = imageFactFrom(service, info);
          if (fact === undefined) {
            throw new Error(`${service}/info.json states no dimensions`);
          }
          return fact;
        },
        signal,
      ),
    store: sqliteFactStore<ImageFact>({
      path: options.storePath,
      table: 'images',
    }),
    limits,
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
            const dataset = context.dataset.iri.toString();
            const selected = await manifests.resolveAll(
              [...manifestOfWork.values()].map((url) => ({ url, dataset })),
            );
            const serviceOfWork = new Map<string, string>();
            for (const [work, manifest] of manifestOfWork) {
              const resolution = selected.get(manifest);
              if (resolution?.outcome === 'resolved') {
                serviceOfWork.set(work, resolution.fact);
              }
            }
            const resolved = await images.resolveAll([
              ...serviceOfWork.values(),
            ]);
            for (const [work, service] of serviceOfWork) {
              const resolution = resolved.get(service);
              if (resolution?.outcome === 'resolved') {
                yield* mint(factory.namedNode(work), resolution.fact, aliases);
              }
            }
          };
    },
    async check() {
      await manifests.check();
      await images.check();
    },
  };
}

const factory = new DataFactory();

const INTEGER = factory.namedNode('http://www.w3.org/2001/XMLSchema#integer');
/** What the profile’s `encodingFormat` for a manifest entry contains. */
const IIIF_PRESENTATION_CONTEXT = 'iiif.io/api/presentation';
/** A manifest’s selection can change, so it is reconsidered after 30 days. */
const MANIFEST_TTL_MS = 30 * 24 * 3_600_000;
/** Answers meaning this document is not ours to have, now or on a retry. */
const ABSENT_STATUSES = new Set([401, 403, 404, 410]);

interface ManifestReference {
  readonly url: string;
  readonly dataset: string;
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
 * between runs and the representative image should not change with it.
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
 * host whose public images are fine.
 */
async function fetchFacts<Fact>(
  keys: readonly string[],
  urlOf: (key: string) => string,
  derive: (document: unknown, key: string) => Fact | undefined,
  signal: AbortSignal,
): Promise<Array<readonly [string, Fact]>> {
  const facts: Array<readonly [string, Fact]> = [];
  for (const key of keys) {
    // Only `*/*`: LDmaX answers 404 to any JSON media type in `Accept`, IIIF’s own
    // included, even with `*/*` as a fallback beside it.
    const response = await fetch(urlOf(key), {
      signal,
      headers: { Accept: '*/*' },
    });
    if (!response.ok) {
      // An unread body keeps its connection until garbage collection.
      await response.body?.cancel();
      if (ABSENT_STATUSES.has(response.status)) {
        continue;
      }
      throw new Error(`${urlOf(key)} answered ${response.status}`);
    }
    const fact = derive(await response.json(), key);
    if (fact !== undefined) {
      facts.push([key, fact]);
    }
  }
  return facts;
}

function* mint(
  work: Quad_Subject,
  fact: ImageFact,
  aliases: Aliases,
): Generator<Quad> {
  const image = factory.blankNode();
  yield triple(work, aliases.representativeImage, image);
  yield triple(image, aliases.image.width, integer(fact.width));
  yield triple(image, aliases.image.height, integer(fact.height));
  for (const size of fact.sizes) {
    const node = factory.blankNode();
    yield triple(image, aliases.image.sizes, node);
    yield triple(node, aliases.size.width, integer(size.width));
    yield triple(node, aliases.size.height, integer(size.height));
    yield triple(node, aliases.size.url, factory.namedNode(size.url));
  }
  const service = factory.blankNode();
  yield triple(image, aliases.image.service, service);
  yield triple(
    service,
    aliases.service.url,
    factory.namedNode(fact.service.url),
  );
  yield triple(
    service,
    aliases.service.type,
    factory.literal(fact.service.type),
  );
  yield triple(
    service,
    aliases.service.profile,
    factory.literal(fact.service.profile),
  );
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
