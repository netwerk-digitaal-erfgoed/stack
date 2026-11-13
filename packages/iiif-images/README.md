# @ndes/iiif-images

Enriches SCHEMA-AP-NDE works with the dimensions and sizes of the IIIF image that
represents them, so a frontend can reserve the right aspect ratio and pick a size
before the image loads.

It is a quad transform for `@lde/search-indexer`. For each work with a IIIF
Presentation manifest in `associatedMedia`, it reads the manifest, selects an image,
reads its image service’s `info.json` if it has one and mints a nested
`representativeImage`.

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

| Option          | Default         | Purpose                                                    |
| --------------- | --------------- | ---------------------------------------------------------- |
| `storePath`     | required        | SQLite file holding resolved facts between runs            |
| `fetchWindowMs` | no limit        | How long after construction a fetch may still start, in ms |
| `report`        | console warning | Called for each reference whose fetch failed               |

`storePath` has to be on a durable volume. The store is the only place these facts
live between runs, and with an empty one every image is fetched from the publisher
again.

## Consuming the field

```json
{
  "representativeImage": {
    "url": "https://example.org/iiif/image/full/max/0/default.jpg",
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
      "url": "https://example.org/iiif/image"
    }
  }
}
```

- Pick the smallest entry in `sizes` that is at least your target width. These are
  sizes the server lists or its tiles precompute, so they are served fastest. Do not
  rely on the array’s order.
- Use `service` only for deep zoom or region crops.
- `url` is the image as the manifest paints it, at full size.
- A static image, one without an image service, has only `url`, `width` and
  `height`: no `sizes` and no `service`, because it is the only version there is
  and cannot be resized.
- Without `representativeImage`, use `associatedMedia[].thumbnailUrl`, with no
  dimensions. That is the case for a work with no manifest, no image in its manifest
  with an image service or a stated size, or a fetch that has not succeeded yet.

## Behaviour

- **Selection:** the first painted image in the manifest that has an image service
  or whose width and height the manifest states, found by
  [@lde/iiif-image](https://ldelements.org/reference/iiif-image). A static image’s
  size comes from the manifest; an image service’s from its `info.json`. Where that
  `info.json` is gone, the image counts as static, if the manifest states its size.
  An image whose `id` is not an absolute `http(s)` URL is passed over.
- **Freshness:** manifest facts are refetched after 30 days, because which image
  represents a work can change. `info.json` facts are refetched after 180 days: an
  image’s dimensions do not change, but its server’s size URLs can.
- **Safety:** fetches go through
  [@lde/public-fetch](https://ldelements.org/reference/public-fetch), which refuses a
  URL, or a redirect target, that is not `http(s)` or names a private address or
  cluster-internal host, and caps a body at 20 MiB. A refused URL or a larger body is
  reported and counts as having no such document. It looks at URLs only, so it does not catch DNS
  pointing inwards. Run the indexer under an egress policy as well.
- **Failures:** a failed fetch is reported and retried on a later run, and the work
  is indexed without an image. A 401, 403, 404 or 410 counts as having no such
  document and is rechecked after a week, so a brief 401 or 403 can replace a stored
  fact for that long. So does a collection, which has no image of its own, and a
  manifest too broken to read. A 200 that is no IIIF document at all, such as an error
  page served as JSON, counts as a failure, so it is retried every run and five in a
  row stop that dataset’s manifests for the run.
- **Window:** without `fetchWindowMs`, a cold store is fetched in one run, as fast
  as each publisher keeps up. With it, a fetch that has not started once the window
  has passed waits for a later run; one already under way finishes. The window covers
  all datasets together, and what it defers is not reported: those works are indexed
  without an image until a later run.
- **Later runs:** retries, deferred works and refreshes all need the dataset to be
  reprocessed. With `PROVENANCE_FILE`, an unchanged dataset waits until it changes
  or `PIPELINE_VERSION` is bumped, so leave `fetchWindowMs` long enough to cover it
  in one run.
- **Limits:** manifest requests are grouped per dataset, because manifest URLs often
  sit on a redirector such as `n2t.net`, and `info.json` requests per host. Datasets
  on one server are limited separately, with only the overall limit across them.
