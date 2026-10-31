import type { QuadTransform, ReaderContext } from '@lde/pipeline';
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
const MANIFEST_FORMAT =
  'application/ld+json;profile="http://iiif.io/api/presentation/3/context.json"';
const CONTEXT: IiifImagesContext = {
  dataset: { iri: new URL('https://example.org/dataset') },
};

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
  return {
    type: 'Manifest',
    items: [
      {
        type: 'Canvas',
        items: [
          {
            type: 'AnnotationPage',
            items: [
              {
                type: 'Annotation',
                body: {
                  type: 'Image',
                  service: [{ id: service, type: 'ImageService3' }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

const INFO = {
  type: 'ImageService3',
  profile: 'level2',
  width: 1335,
  height: 2750,
  sizes: [{ width: 83, height: 172 }],
};

const ENRICHED_IMAGE = {
  width: 1335,
  height: 2750,
  sizes: [
    { width: 83, height: 172, url: `${SERVICE}/full/83,172/0/default.jpg` },
  ],
  service: { url: SERVICE, type: 'ImageService3', profile: 'level2' },
};

/** Answer each URL from `documents`, as a JSON body or a bare status. */
function serve(documents: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const answer = documents[String(input)];
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
): Promise<SearchDocument[]> {
  const transformed: Quad[] = [];
  async function* source() {
    yield* quads;
  }
  for await (const quad of enrich(source(), CONTEXT)) {
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

  it('stops fetching at the per-run budget and leaves the rest for later', async () => {
    const otherManifest = 'https://n2t.net/ark:/1/other.json';
    const fetchMock = serve({
      ...servedBoth,
      [otherManifest]: manifestPainting(),
    });
    const otherWork = 'https://example.org/work/2';

    const documents = await run(
      enrichment({ fetchesPerRun: 1 }),
      [...workWithManifest(), ...workWithManifest(otherWork, otherManifest)],
      [WORK, otherWork],
    );

    expect(
      documents.filter(
        (document) => document.representativeImage !== undefined,
      ),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
