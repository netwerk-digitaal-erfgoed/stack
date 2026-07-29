import { Client } from '@lde/dataset-registry-client';
import { type DatasetSelector, RegistrySelector } from '@lde/pipeline';

/**
 * Default DCAT-AP Dataset Register SPARQL endpoint (the same one the EDM export
 * pipeline queries).
 */
export const DEFAULT_REGISTRY_ENDPOINT = new URL(
  'https://triplestore.netwerkdigitaalerfgoed.nl/repositories/registry',
);

/**
 * The `dcterms:conformsTo` value a distribution declares to mark itself as
 * Linked Art. This is the mapping’s input contract: only sources that declare
 * conformance are selected.
 */
export const LINKED_ART_PROFILE = 'https://linked.art/ns/terms/';

export interface DatasetSelectorOptions {
  /** Dataset Register SPARQL endpoint. @default {@link DEFAULT_REGISTRY_ENDPOINT} */
  registryEndpoint?: URL;
  /** The profile a distribution must declare via `dcterms:conformsTo`. @default {@link LINKED_ART_PROFILE} */
  conformsTo?: string;
  /** Restrict selection to a single dataset IRI instead of all Linked Art sources. */
  datasetIri?: URL;
}

/**
 * Selects datasets to project: those published in Linked Art, discovered from
 * the DCAT-AP Dataset Register by their declared `dcterms:conformsTo`.
 */
export function createLinkedArtDatasetSelector(
  options: DatasetSelectorOptions = {},
): DatasetSelector {
  const registry = new Client(
    options.registryEndpoint ?? DEFAULT_REGISTRY_ENDPOINT,
  );
  const conformsTo = options.conformsTo ?? LINKED_ART_PROFILE;

  return new RegistrySelector({
    registry,
    criteria: {
      ...(options.datasetIri && { $id: options.datasetIri.toString() }),
      distribution: { conformsTo },
    },
  });
}
