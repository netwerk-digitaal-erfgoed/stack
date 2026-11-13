import type { QuadTransform, ReaderContext } from '@lde/pipeline';
import { sqliteFactStore } from '@lde/resolver';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  projectRoots,
  searchSchema,
  type RootType,
  type SearchDocument,
  type SearchType,
} from '@lde/search';
import { fieldNamed, irAlias } from '@lde/search/adapter';
import type { Quad } from '@rdfjs/types';
import { DataFactory } from 'rdf-data-factory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { iiifImageTypes, representativeImageField } from '../schema.js';
import { iiifImages, type IiifImagesContext } from './iiif-images.js';

const factory = new DataFactory();

const WORK = 'https://example.org/work/1';
const MANIFEST = 'https://n2t.net/ark:/1/manifest.json';
const SERVICE = 'https://images.example.org/iiif/3/image';
const IMAGE = `${SERVICE}/full/max/0/default.jpg`;
const GONE_SERVICE = 'https://images.example.org/iiif/3/gone';
const MANIFEST_FORMAT =
  'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"';
const CONTEXT: IiifImagesContext = {};

const mediaObject: SearchType = {
  name: 'MediaObject',
  fields: [
    {
      name: 'encodingFormat',
      kind: 'keyword',
      array: true,
      path: 'https://schema.org/encodingFormat',
    },
  ],
};
const creativeWork: RootType = {
  name: 'CreativeWork',
  class: 'https://schema.org/CreativeWork',
  fields: [
    representativeImageField,
    {
      name: 'associatedMedia',
      kind: 'reference',
      array: true,
      path: 'https://schema.org/associatedMedia',
      ref: { typeName: 'MediaObject', strategy: 'inline' },
    },
  ],
};
const schema = searchSchema(creativeWork, mediaObject, ...iiifImageTypes);

function alias(searchType: SearchType, name: string) {
  const field = fieldNamed(searchType, name);
  if (field === undefined) {
    throw new Error(`${searchType.name} declares no field “${name}”.`);
  }
  return factory.namedNode(irAlias(searchType, field));
}

/** A work whose `associatedMedia` holds a manifest entry, as extracted. */
function workWithManifest(work = WORK, manifest = MANIFEST): Quad[] {
  return [
    factory.quad(
      factory.namedNode(work),
      alias(creativeWork, 'associatedMedia'),
      factory.namedNode(manifest),
    ),
    factory.quad(
      factory.namedNode(manifest),
      alias(mediaObject, 'encodingFormat'),
      factory.literal(MANIFEST_FORMAT),
    ),
  ];
}

function manifestPainting(service = SERVICE) {
  return manifestOf(imageWithService(service));
}

function imageWithService(service = SERVICE) {
  return {
    id: `${service}/full/max/0/default.jpg`,
    type: 'Image',
    service: [{ id: service, type: 'ImageService3' }],
  };
}

/** That many distinct image services that are gone. */
function goneServices(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `${GONE_SERVICE}-${index}`,
  );
}

/** A manifest painting one canvas per body. */
function manifestOf(...bodies: unknown[]) {
  return {
    type: 'Manifest',
    items: bodies.map((body) => ({
      type: 'Canvas',
      items: [
        {
          type: 'AnnotationPage',
          items: [{ type: 'Annotation', body }],
        },
      ],
    })),
  };
}

/** A plain image file, as Drapo paints them. */
const UNSIZED_IMAGE = {
  id: 'https://images.example.org/static.jpg',
  type: 'Image',
  format: 'image/jpeg',
};
const STATIC_IMAGE = { ...UNSIZED_IMAGE, width: 1466, height: 2000 };

const INFO = {
  type: 'ImageService3',
  profile: 'level2',
  width: 1335,
  height: 2750,
  sizes: [{ width: 83, height: 172 }],
};

const ENRICHED_IMAGE = {
  url: IMAGE,
  width: 1335,
  height: 2750,
  sizes: [
    { width: 83, height: 172, url: `${SERVICE}/full/83,172/0/default.jpg` },
  ],
  service: { url: SERVICE },
};

/** Answer each URL from `documents`, as a JSON body, a bare status or a response. */
function serve(documents: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const answer = documents[String(input)];
    if (answer instanceof Response) {
      return answer;
    }
    return typeof answer === 'number'
      ? new Response(null, { status: answer })
      : answer === undefined
        ? new Response(null, { status: 404 })
        : Response.json(answer);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const servedBoth = {
  [MANIFEST]: manifestPainting(),
  [`${SERVICE}/info.json`]: INFO,
};

function enrichment(options: Partial<Parameters<typeof iiifImages>[1]> = {}) {
  const enrich = iiifImages(schema, {
    storePath: ':memory:',
    report: () => undefined,
    ...options,
  }).transformFor(creativeWork);
  if (enrich === undefined) {
    throw new Error('The test schema declares the fields.');
  }
  return enrich;
}

async function run(
  enrich: ReturnType<typeof enrichment>,
  quads: readonly Quad[],
  works: readonly string[] = [WORK],
  context: IiifImagesContext = CONTEXT,
): Promise<SearchDocument[]> {
  const transformed: Quad[] = [];
  async function* source() {
    yield* quads;
  }
  for await (const quad of enrich(source(), context)) {
    transformed.push(quad);
  }
  const documents: SearchDocument[] = [];
  for await (const document of projectRoots(
    transformed,
    works,
    schema,
    creativeWork,
  )) {
    documents.push(document);
  }
  return documents;
}

describe('iiifImages', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout'], shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('attaches where a reader takes a quad transform', () => {
    const transform: QuadTransform<ReaderContext> = enrichment();

    expect(transform).toBeTypeOf('function');
  });

  it('gives a work with a manifest its representative image', async () => {
    serve(servedBoth);

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
  });

  it('gives a static image its size from the manifest, with no sizes and no service', async () => {
    const fetchMock = serve({ [MANIFEST]: manifestOf(STATIC_IMAGE) });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual({
      url: STATIC_IMAGE.id,
      width: 1466,
      height: 2000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes over a static image that states no size for the next image', async () => {
    serve({
      [MANIFEST]: manifestOf(UNSIZED_IMAGE, imageWithService()),
      [`${SERVICE}/info.json`]: INFO,
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
  });

  it('falls back on the size the manifest states when the image service is gone', async () => {
    serve({
      [MANIFEST]: manifestOf({
        ...imageWithService(),
        width: 1335,
        height: 2750,
      }),
      [`${SERVICE}/info.json`]: 404,
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual({
      url: IMAGE,
      width: 1335,
      height: 2750,
    });
  });

  it('falls back on the next image when an image service is gone and the manifest states no size', async () => {
    serve({
      [MANIFEST]: manifestOf(
        imageWithService(GONE_SERVICE),
        imageWithService(SERVICE),
      ),
      [`${GONE_SERVICE}/info.json`]: 404,
      [`${SERVICE}/info.json`]: INFO,
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
  });

  it('fetches a later image’s service only once the image before it is gone', async () => {
    const fetchMock = serve({
      [MANIFEST]: manifestOf(
        imageWithService(SERVICE),
        imageWithService(GONE_SERVICE),
      ),
      [`${SERVICE}/info.json`]: INFO,
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${GONE_SERVICE}/info.json`,
      expect.anything(),
    );
  });

  it('keeps waiting on an image whose service failed, rather than falling back', async () => {
    const fetchMock = serve({
      [MANIFEST]: manifestOf(
        imageWithService(GONE_SERVICE),
        imageWithService(SERVICE),
      ),
      [`${GONE_SERVICE}/info.json`]: 500,
      [`${SERVICE}/info.json`]: INFO,
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${SERVICE}/info.json`,
      expect.anything(),
    );
  });

  it('serves the fallback from the store on a later run', async () => {
    const fetchMock = serve({
      [MANIFEST]: manifestOf(
        imageWithService(GONE_SERVICE),
        imageWithService(SERVICE),
      ),
      [`${GONE_SERVICE}/info.json`]: 404,
      [`${SERVICE}/info.json`]: INFO,
    });
    const enrich = enrichment();
    await run(enrich, workWithManifest());
    fetchMock.mockClear();

    const [document] = await run(enrich, workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('considers only the first ten usable images', async () => {
    const gone = goneServices(10);
    const fetchMock = serve({
      [MANIFEST]: manifestOf(
        ...gone.map((service) => imageWithService(service)),
        imageWithService(SERVICE),
      ),
      [`${SERVICE}/info.json`]: INFO,
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    for (const service of gone) {
      expect(fetchMock).toHaveBeenCalledWith(
        `${service}/info.json`,
        expect.anything(),
      );
    }
    expect(fetchMock).not.toHaveBeenCalledWith(
      `${SERVICE}/info.json`,
      expect.anything(),
    );
  });

  it('does not count an image painted again as a further candidate', async () => {
    const gone = goneServices(9);
    serve({
      [MANIFEST]: manifestOf(
        ...gone.map((service) => imageWithService(service)),
        imageWithService(gone[0]),
        imageWithService(SERVICE),
      ),
      [`${SERVICE}/info.json`]: INFO,
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
  });

  it('reads a manifest fact stored as a single image, without refetching it', async () => {
    const storePath = join(
      await mkdtemp(join(tmpdir(), 'iiif-images-')),
      'store.sqlite',
    );
    const store = sqliteFactStore({ path: storePath, table: 'manifests' });
    await store.set(
      new Map([
        [
          MANIFEST,
          { status: 'present', fact: { url: IMAGE, service: SERVICE } },
        ],
      ]),
      new Date().toISOString(),
      '2',
    );
    await store.close?.();
    const fetchMock = serve({ [`${SERVICE}/info.json`]: INFO });

    const [document] = await run(enrichment({ storePath }), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
    expect(fetchMock).not.toHaveBeenCalledWith(MANIFEST, expect.anything());
  });

  it('passes over an image whose id is not an absolute web address', async () => {
    serve({
      [MANIFEST]: manifestOf(
        { ...STATIC_IMAGE, id: 'images/1.jpg' },
        STATIC_IMAGE,
      ),
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toMatchObject({
      url: STATIC_IMAGE.id,
    });
  });

  it('stores a manifest whose only image states no size as an absence', async () => {
    const fetchMock = serve({ [MANIFEST]: manifestOf(UNSIZED_IMAGE) });
    const report = vi.fn();
    const enrich = enrichment({ report });

    await run(enrich, workWithManifest());
    const [document] = await run(enrich, workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts only */*, because LDmaX answers a JSON media type with a 404', async () => {
    const fetchMock = serve(servedBoth);

    await run(enrichment(), workWithManifest());

    for (const [, init] of fetchMock.mock.calls as unknown as [
      string,
      RequestInit,
    ][]) {
      expect(init.headers).toEqual({ Accept: '*/*' });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('leaves a work without a manifest alone, and fetches nothing', async () => {
    const fetchMock = serve({});
    const quads = [
      factory.quad(
        factory.namedNode(WORK),
        alias(creativeWork, 'associatedMedia'),
        factory.blankNode(),
      ),
    ];

    const [document] = await run(enrichment(), quads);

    expect(document.representativeImage).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts the deprecated single quotes around the manifest profile', async () => {
    serve(servedBoth);
    const quads = [
      workWithManifest()[0],
      factory.quad(
        factory.namedNode(MANIFEST),
        alias(mediaObject, 'encodingFormat'),
        factory.literal(
          "application/ld+json;profile='http://iiif.io/api/presentation/3/context.json'",
        ),
      ),
    ];

    const [document] = await run(enrichment(), quads);

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
  });

  it('does not mistake an image service’s format for a manifest', async () => {
    const fetchMock = serve(servedBoth);
    const quads = [
      workWithManifest()[0],
      factory.quad(
        factory.namedNode(MANIFEST),
        alias(mediaObject, 'encodingFormat'),
        factory.literal(
          'application/ld+json;profile="http://iiif.io/api/image/3/context.json"',
        ),
      ),
    ];

    await run(enrichment(), quads);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('counts what became of each manifest and image service', async () => {
    serve(servedBoth);
    const count = vi.fn();

    await run(enrichment(), workWithManifest(), [WORK], { ...CONTEXT, count });

    expect(count.mock.calls).toEqual([
      ['manifests fetched'],
      ['image services fetched'],
    ]);
  });

  it('writes off one organisation’s ARKs on n2t.net without the others', async () => {
    const failing = (n: number) => `https://n2t.net/ark:/11111/manifest-${n}`;
    const healthy = 'https://n2t.net/ark:/22222/manifest';
    serve({
      ...Object.fromEntries(
        Array.from({ length: 6 }, (_, n) => [failing(n), 500]),
      ),
      [healthy]: manifestPainting(),
      [`${SERVICE}/info.json`]: INFO,
    });
    const enrich = enrichment();
    for (let n = 0; n < 5; n++) {
      await run(enrich, workWithManifest(WORK, failing(n)));
    }
    const count = vi.fn();
    const otherWork = 'https://example.org/work/2';

    const documents = await run(
      enrich,
      [
        ...workWithManifest(WORK, failing(5)),
        ...workWithManifest(otherWork, healthy),
      ],
      [WORK, otherWork],
      { ...CONTEXT, count },
    );

    expect(count).toHaveBeenCalledWith('manifests written off');
    expect(count).toHaveBeenCalledWith('manifests fetched');
    expect(documents[1].representativeImage).toEqual(ENRICHED_IMAGE);
  });

  it('tries a manifest again within the run when its server answers 429', async () => {
    let answered = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === MANIFEST && !answered) {
          answered = true;
          return new Response(null, {
            status: 429,
            headers: { 'Retry-After': '0' },
          });
        }
        const document = servedBoth[String(input) as keyof typeof servedBoth];
        return Response.json(document);
      }),
    );

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
  });

  it('waits out a 503’s Retry-After and tries the manifest again', async () => {
    const started = Date.now();
    let answered = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        if (String(input) === MANIFEST && !answered) {
          answered = true;
          return new Response(null, {
            status: 503,
            headers: { 'Retry-After': '1' },
          });
        }
        const document = servedBoth[String(input) as keyof typeof servedBoth];
        return Response.json(document);
      }),
    );

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);
  });

  it('indexes the work without an image when the manifest is gone', async () => {
    serve({ [MANIFEST]: 404 });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
  });

  it('refuses a service URL naming a private address, and reports it', async () => {
    const internal = 'http://169.254.169.254/latest';
    const fetchMock = serve({ [MANIFEST]: manifestPainting(internal) });
    const report = vi.fn();

    const [document] = await run(enrichment({ report }), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(MANIFEST, expect.anything());
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ key: internal }),
    );
  });

  it('refuses a manifest IRI naming a cluster-internal host', async () => {
    const internal = 'http://search-api.default.svc/manifest';
    const fetchMock = serve({});

    await run(enrichment(), workWithManifest(WORK, internal));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores a refused URL as an absence, so a later run does not report it again', async () => {
    const internal = 'http://search-api.default.svc/manifest';
    serve({});
    const report = vi.fn();
    const enrich = enrichment({ report });

    await run(enrich, workWithManifest(WORK, internal));
    report.mockClear();
    await run(enrich, workWithManifest(WORK, internal));

    expect(report).not.toHaveBeenCalled();
  });

  it('refuses a redirect to a private address', async () => {
    const fetchMock = serve({
      [MANIFEST]: new Response(null, {
        status: 302,
        headers: { location: 'http://10.0.0.1/manifest' },
      }),
    });

    const [document] = await run(enrichment(), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores a collection as an absence rather than reporting it', async () => {
    serve({
      [MANIFEST]: {
        type: 'Collection',
        items: [{ id: 'https://example.org/m', type: 'Manifest' }],
      },
    });
    const report = vi.fn();

    const [document] = await run(enrichment({ report }), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it('stores a manifest too broken to read as an absence rather than reporting it', async () => {
    serve({
      [MANIFEST]: {
        '@context': 'http://iiif.io/api/presentation/2/context.json',
        '@id': MANIFEST,
        '@type': 'sc:Manifest',
        sequences: [
          {
            '@type': 'sc:Sequence',
            canvases: [
              {
                '@id': 'https://example.org/canvas',
                '@type': 'sc:Canvas',
                images: [null],
              },
            ],
          },
        ],
      },
    });
    const report = vi.fn();

    const [document] = await run(enrichment({ report }), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a document too large to read, and stores it as an absence', async () => {
    const fetchMock = serve({
      [MANIFEST]: new Response('{}', {
        headers: { 'content-length': String(21 * 1024 * 1024) },
      }),
    });
    const report = vi.fn();
    const enrich = enrichment({ report });

    await run(enrich, workWithManifest());
    await run(enrich, workWithManifest());

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ key: MANIFEST }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('leaves a work named by a blank node alone', async () => {
    const fetchMock = serve(servedBoth);
    const work = factory.blankNode();
    const [, manifestEntry] = workWithManifest();
    const quads = [
      factory.quad(
        work,
        alias(creativeWork, 'associatedMedia'),
        factory.namedNode(MANIFEST),
      ),
      manifestEntry,
    ];

    await run(enrichment(), quads, []);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('indexes the work without an image and reports when a fetch keeps failing', async () => {
    serve({ [MANIFEST]: 503 });
    const report = vi.fn();

    const [document] = await run(enrichment({ report }), workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ key: MANIFEST, degradedToStore: false }),
    );
  });

  it.each([401, 403, 410])(
    'treats a %i as an absence, not a failure',
    async (status) => {
      const report = vi.fn();
      serve({
        [MANIFEST]: manifestPainting(),
        [`${SERVICE}/info.json`]: status,
      });

      const [document] = await run(enrichment({ report }), workWithManifest());

      expect(document.representativeImage).toBeUndefined();
      expect(report).not.toHaveBeenCalled();
    },
  );

  it('reports a 200 that is no manifest, rather than storing an absence', async () => {
    serve({ [MANIFEST]: { error: 'down for maintenance' } });
    const report = vi.fn();

    await run(enrichment({ report }), workWithManifest());

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ key: MANIFEST }),
    );
  });

  it('reports a 200 info.json without dimensions, rather than storing an absence', async () => {
    serve({
      [MANIFEST]: manifestPainting(),
      [`${SERVICE}/info.json`]: { error: 'down for maintenance' },
    });
    const report = vi.fn();

    await run(enrichment({ report }), workWithManifest());

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ key: SERVICE }),
    );
  });

  it('settles on the same manifest whatever order a work’s entries arrive in', async () => {
    const earlier = 'https://n2t.net/ark:/1/earlier.json';
    const otherService = 'https://images.example.org/iiif/3/other';
    serve({
      ...servedBoth,
      [earlier]: manifestPainting(otherService),
      [`${otherService}/info.json`]: INFO,
    });

    const [document] = await run(enrichment(), [
      ...workWithManifest(),
      ...workWithManifest(WORK, earlier),
    ]);

    expect(document.representativeImage).toMatchObject({
      service: { url: otherService },
    });
  });

  it('resolves a shared image service once, for every work using it', async () => {
    const otherManifest = 'https://n2t.net/ark:/1/other.json';
    const fetchMock = serve({
      ...servedBoth,
      [otherManifest]: manifestPainting(),
    });
    const otherWork = 'https://example.org/work/2';

    const documents = await run(
      enrichment(),
      [...workWithManifest(), ...workWithManifest(otherWork, otherManifest)],
      [WORK, otherWork],
    );

    expect(documents.map((document) => document.representativeImage)).toEqual([
      ENRICHED_IMAGE,
      ENRICHED_IMAGE,
    ]);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('info.json')),
    ).toHaveLength(1);
  });

  it('serves stored facts without fetching again', async () => {
    const fetchMock = serve(servedBoth);
    const enrich = enrichment();

    await run(enrich, workWithManifest());
    fetchMock.mockClear();
    const [document] = await run(enrich, workWithManifest());

    expect(document.representativeImage).toEqual(ENRICHED_IMAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('starts no fetch once the fetch window has passed', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'Date'],
      shouldAdvanceTime: true,
    });
    const fetchMock = serve(servedBoth);
    const enrich = enrichment({ fetchWindowMs: 1_000 });
    vi.setSystemTime(Date.now() + 1_001);

    const [document] = await run(enrich, workWithManifest());

    expect(document.representativeImage).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers no transform to a type that has not declared the field', () => {
    const undeclared: RootType = {
      name: 'Person',
      class: 'https://schema.org/Person',
      fields: [
        { name: 'name', kind: 'keyword', path: 'https://schema.org/name' },
      ],
    };

    const images = iiifImages(searchSchema(undeclared), {
      storePath: ':memory:',
    });

    expect(images.transformFor(undeclared)).toBeUndefined();
  });

  it('passes a store check on a writable store', async () => {
    const images = iiifImages(schema, { storePath: ':memory:' });

    await expect(images.check()).resolves.toBeUndefined();
  });
});
