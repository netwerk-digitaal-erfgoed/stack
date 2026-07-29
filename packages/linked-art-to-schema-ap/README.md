# @ndes/linked-art-to-schema-ap

Projects [Linked Art](https://linked.art/) (CIDOC-CRM) collections into the
[SCHEMA-AP-NDE](https://docs.nde.nl/stack/patterns#schema-ap-nde-first) pivot,
built on [`@lde/pipeline`](https://www.npmjs.com/package/@lde/pipeline).

A Linked-Art-native institution manages its collection in CIDOC-CRM but must
still publish SCHEMA-AP-NDE to join the network. This pipeline maps **Linked Art
to the SCHEMA-AP-NDE pivot** – the inverse direction of the EDM export. Because
Linked Art is a shared standard, one mapping covers every Linked-Art source.

## How it works

The pipeline runs the standard Data Layer stages, specialising from **Project**
onward:

| Stage       | This pipeline                                                                            |
| ----------- | ---------------------------------------------------------------------------------------- |
| Discover    | DCAT-AP Dataset Register, selecting sources that declare `dcterms:conformsTo` Linked Art |
| Read        | Each source’s data dump is imported into a local QLever index                            |
| Project     | Per-class SPARQL `CONSTRUCT` from Linked Art into the SCHEMA-AP-NDE pivot                |
| Validate    | The projection is validated against the SCHEMA-AP-NDE SHACL shapes                       |
| Materialise | Written as Turtle                                                                        |

Projection uses one `CONSTRUCT` per target class, and within each query uses
`UNION` (one branch per multi-valued property) rather than `OPTIONAL`, so that
multi-valued properties do not multiply into cross-product duplicates.

## Usage

```typescript
import { buildPipeline } from '@ndes/linked-art-to-schema-ap';

const { pipeline, distributionResolver } = await buildPipeline({
  outputDir: 'output',
});

try {
  await pipeline.run();
} finally {
  await distributionResolver.cleanup();
}
```

Project a single source instead of every Linked Art dataset:

```typescript
await buildPipeline({
  datasetIri: new URL(
    'https://data.spinque.com/ld/data/vangoghworldwide/van_gogh_museum/',
  ),
});
```

`buildPipeline` accepts: `outputDir`, `shapesFile` (path or URL),
`registryEndpoint`, `conformsTo`, `datasetIri`, and `qlever`
(`{ mode: 'native' }` or `{ mode: 'docker', image }`). Native mode requires the
`qlever` CLI on the `PATH`.

## Status

The mapping is a **starter subset**: it projects `schema:CreativeWork` with
name, classification, creator, creation date and representation. The
record-level required fields (`schema:sdDatePublished`, `schema:isPartOf`) and
language-tagged `schema:name` are not yet derived – the validation stage reports
where the projection falls short of the SCHEMA-AP-NDE shapes. Extend
[`src/lib/queries.ts`](./src/lib/queries.ts) to complete the mapping.
