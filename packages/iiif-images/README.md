# @ndes/iiif-images

Enriches SCHEMA-AP-NDE works with the dimensions and sizes of the IIIF image that
represents them, so a frontend can reserve the right aspect ratio and pick a size
before the image loads.

It is a quad transform for `@lde/search-indexer`. For each work with a IIIF
Presentation manifest in `associatedMedia`, it reads the manifest, selects an image
service, reads that service’s `info.json` and mints a nested `representativeImage`.

## Usage

Declare the fields in your schema module. The `/schema` entry point has no runtime
dependencies, so a bundled schema module stays self-contained:

```ts
import {
  iiifImageTypes,
  representativeImageField,
} from '@ndes/iiif-images/schema';

const creativeWork = defineSearchType({
  name: 'CreativeWork',
  class: 'https://schema.org/CreativeWork',
  fields: [representativeImageField /* … */],
});
```

Add `iiifImageTypes` to the schema, then attach the transform after any transform
that repairs IRIs:

```ts
import { iiifImages } from '@ndes/iiif-images';

const images = iiifImages(schema, { storePath: '/provenance/iiif.sqlite' });
await images.check();

const transform = images.transformFor(creativeWork);
const pipeline = await createSearchIndexer(config, {
  transforms: {
    CreativeWork: [anyUriToIri(schema), ...(transform ? [transform] : [])],
  },
});
```

`transformFor` answers `undefined` for a root type that does not declare
`representativeImage` and `associatedMedia`, so a deployment on an older schema loses
the enrichment rather than the run.

| Option          | Default         | Purpose                                                  |
| --------------- | --------------- | -------------------------------------------------------- |
| `storePath`     | required        | SQLite file holding resolved facts between runs          |
| `fetchesPerRun` | 500             | Manifests, and separately `info.json` documents, per run |
| `report`        | console warning | Called for each reference whose fetch failed             |

`storePath` has to be on a durable volume. The store is the only place these facts
live between runs, and with an empty one every image is fetched from the publisher
again.

## Consuming the field

```json
{
  "representativeImage": {
    "width": 1335,
    "height": 2750,
    "sizes": [
      {
        "width": 83,
        "height": 172,
        "url": "https://example.org/iiif/image/full/83,172/0/default.jpg"
      }
    ],
    "service": {
      "url": "https://example.org/iiif/image",
      "type": "ImageService3",
      "profile": "level2"
    }
  }
}
```

- Pick the smallest entry in `sizes` that is at least your target width. These are
  sizes the server lists or its tiles precompute, so they are served fastest. Do not
  rely on the array’s order.
- Use `service` only for deep zoom or region crops.
- Without `representativeImage`, use `associatedMedia[].thumbnailUrl`, with no
  dimensions. That is the case for a work with no manifest, no image service in its
  manifest, or a fetch that has not succeeded yet.

## Behaviour

- **Selection:** the first painted image in the manifest that has an image service.
- **Freshness:** `info.json` facts never expire, because an image identifier’s
  dimensions do not change. Manifest facts are refetched after 30 days, because
  which image represents a work can.
- **Failures:** a failed fetch is reported and retried on a later run, and the work
  is indexed without an image. A 401, 403, 404 or 410 counts as having no such
  document and is rechecked after a week.
- **Budget:** `fetchesPerRun` covers all datasets together. What it defers is not
  reported, and those works are indexed without an image until a later run.
- **Later runs:** retries, deferred works and refreshes all need the dataset to be
  reprocessed. With `PROVENANCE_FILE`, an unchanged dataset waits until it changes
  or `PIPELINE_VERSION` is bumped, so set `fetchesPerRun` high enough to cover it in
  one run.
- **Limits:** manifest requests are grouped per dataset, because manifest URLs often
  sit on a redirector such as `n2t.net`, and `info.json` requests per host. Datasets
  on one server are limited separately, with only the overall limit across them.
