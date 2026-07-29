# Linked Art to SCHEMA-AP-NDE pipeline

> **Draft – under review.** Not yet endorsed by NDE. Extracted from the [NDE Stack documentation](https://docs.nde.nl/stack/pipeline).

A [Linked Art](https://linked.art/)-native institution manages its collection in a CIDOC-CRM application profile but must still publish [SCHEMA-AP-NDE](https://docs.nde.nl/stack/patterns#schema-ap-nde-first) to join the network. This pipeline maps **Linked Art to the SCHEMA-AP-NDE pivot** – the inverse direction of the [EDM export](https://docs.nde.nl/stack/pipeline#example-edm-export-loda-pipeline): EDM maps the pivot _outward_ to a delivery model; this maps a domain model _inward_ to the pivot. Because Linked Art is a shared standard, one mapping covers every Linked-Art source – the same one-mapping-per-model economy that makes [SCHEMA-AP-NDE-first](https://docs.nde.nl/stack/patterns#schema-ap-nde-first) an O(n+m) win.

It runs **provider-side**: the publisher generates its SCHEMA-AP-NDE publication with NDE-provided mapping software, the same way a publisher can generate EDM “using software NDE provides for free”. SCHEMA-AP-NDE-first is preserved – the provider still publishes the pivot, it just derives rather than hand-authors it. This also realises the [Parallel Data Models](https://docs.nde.nl/stack/patterns#parallel-data-models) tradeoff that representations are “easier when generated from a shared internal representation than maintained in parallel”: Linked Art is the authoritative internal representation and SCHEMA-AP-NDE is derived from it, so the two cannot drift. A central ingest-adapter variant (NDE synthesising SCHEMA-AP-NDE for Linked-Art-only sources) is possible but shifts conformance ownership and is a governance decision, not just a pipeline configuration.

| Axis       | Choice                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------------- |
| Discovery  | DCAT-AP registry (Dataset Register), selecting sources that declare `dcterms:conformsTo` Linked Art           |
| Selection  | Datasets published in Linked Art – the domain shape is the mapping’s input contract                           |
| Scope      | Full re-projection per run                                                                                    |
| Validation | Separate target shapes – validate the **output** against SCHEMA-AP-NDE SHACL, the mapping’s success criterion |
| Deploy     | SCHEMA-AP-NDE distribution the provider publishes (RDF dump, SPARQL, and/or LDES)                             |
| State      | None                                                                                                          |

Projection is **SPARQL CONSTRUCT mapping Linked Art to SCHEMA-AP-NDE**: each source’s Linked Art is imported into QLever and CONSTRUCTed into the pivot, then SHACL-validated against the [schema-profile](https://github.com/netwerk-digitaal-erfgoed/schema-profile) shapes. As with EDM, per-class CONSTRUCTs split into separate executors joined by `UNION` rather than `OPTIONAL`, so multi-valued properties don’t multiply into cross-product duplicates. The mapping is lossy by design – CIDOC-CRM’s event-based structure flattens into schema.org properties – which is acceptable because the pivot is intentionally a [minimum, not the full picture](https://docs.nde.nl/stack/patterns#schema-ap-nde-first), and the richer Linked Art stays available alongside it via [Parallel Data Models](https://docs.nde.nl/stack/patterns#parallel-data-models). The axis structure is the same as the Search, KG, and EDM pipelines, aimed at the pivot as its target shape.

The test datasets for this pipeline are the [Van Gogh Worldwide](https://vangoghworldwide.org/) collections, each published in Linked Art and registered in the [Dataset Register](https://docs.nde.nl/services/dataset-register/):

| #   | Dataset                 | Dataset Register                                                                                                                                                                |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Baltimore Museum of Art | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fbaltimore_museum_of_art%2F) |
| 2   | Barnes Foundation       | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fbarnes_foundation%2F)       |
| 3   | Buffalo AKG             | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fbuffalo_akg%2F)             |
| 4   | Fitzwilliam Museum      | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Ffitzwilliam_museum%2F)      |
| 5   | Kröller-Müller Museum   | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fkrollermuller_museum%2F)    |
| 6   | Kunsthaus Zürich        | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fkunsthaus_zurich%2F)        |
| 7   | Kunstmuseum             | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fkunstmuseum%2F)             |
| 8   | Noord-Brabants Museum   | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fnoord_brabants_museum%2F)   |
| 9   | Norton Simon Museum     | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fnorton_simon_museum%2F)     |
| 10  | RKD Collections         | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Frkd_collections%2F)         |
| 11  | Toledo Museum of Art    | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Ftoledo_museum_of_art%2F)    |
| 12  | Van Gogh Museum         | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fvan_gogh_museum%2F)         |
| 13  | Wellcome Collection     | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fwellcome_collection%2F)     |
| 14  | Yale                    | [View in Register](https://datasetregister.netwerkdigitaalerfgoed.nl/en/dataset?uri=https%3A%2F%2Fdata.spinque.com%2Fld%2Fdata%2Fvangoghworldwide%2Fyale%2F)                    |
