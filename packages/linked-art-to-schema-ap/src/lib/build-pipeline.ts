import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  FileWriter,
  ImportResolver,
  Pipeline,
  SparqlConstructExecutor,
  SparqlDistributionResolver,
  SparqlItemSelector,
  Stage,
} from '@lde/pipeline';
import { ConsoleReporter } from '@lde/pipeline-console-reporter';
import { ShaclValidator } from '@lde/pipeline-shacl-validator';
import { createQlever } from '@lde/sparql-qlever';
import {
  createLinkedArtDatasetSelector,
  type DatasetSelectorOptions,
} from './dataset-selector.js';
import { MAPPING_QUERIES, SELECT_HUMAN_MADE_OBJECTS } from './queries.js';

/**
 * Canonical SCHEMA-AP-NDE SHACL shapes. The projection is validated against
 * these – the mapping’s success criterion – rather than against the source.
 */
export const DEFAULT_SHAPES_FILE =
  'https://raw.githubusercontent.com/netwerk-digitaal-erfgoed/schema-profile/main/shacl.ttl';

export interface BuildPipelineOptions extends DatasetSelectorOptions {
  /**
   * Working directory for QLever imports and projected output. Created if it
   * does not exist. @default 'output'
   */
  outputDir?: string;
  /**
   * SHACL shapes to validate the projection against (file path or URL; any
   * format `rdf-dereference` accepts). @default {@link DEFAULT_SHAPES_FILE}
   */
  shapesFile?: string;
  /**
   * QLever runtime. `native` requires the `qlever` CLI on the PATH; `docker`
   * runs the published image. @default `{ mode: 'native' }`
   */
  qlever?:
    | { mode: 'native' }
    | { mode: 'docker'; image: string; containerName?: string };
}

/**
 * Builds the Linked Art → SCHEMA-AP-NDE pipeline.
 *
 * Discovers Linked Art sources from the Dataset Register, imports each source’s
 * data dump into a local QLever, projects it into the SCHEMA-AP-NDE pivot with
 * per-class SPARQL CONSTRUCTs, validates the projection against the
 * SCHEMA-AP-NDE shapes, and writes the result as Turtle.
 *
 * Returns the configured {@link Pipeline} and its {@link ImportResolver} so the
 * caller can run it (`await pipeline.run()`) and clean up the QLever server
 * afterwards (`await distributionResolver.cleanup()`).
 */
export async function buildPipeline(
  options: BuildPipelineOptions = {},
): Promise<{ pipeline: Pipeline; distributionResolver: ImportResolver }> {
  const outputDir = resolve(options.outputDir ?? 'output');
  const importsDir = resolve(outputDir, 'imports');
  await mkdir(importsDir, { recursive: true });

  // Import data dumps into a local QLever rather than querying remote
  // endpoints, so each source is projected from a consistent local index.
  const qlever = createQlever({
    ...(options.qlever ?? { mode: 'native' }),
    dataDir: importsDir,
  });
  const distributionResolver = new ImportResolver(
    new SparqlDistributionResolver(),
    { importer: qlever.importer, server: qlever.server, strategy: 'import' },
  );

  // Validate the projection against the SCHEMA-AP-NDE shapes; report violations
  // (write them alongside the output) and continue, rather than halting.
  const validator = new ShaclValidator({
    shapesFile: options.shapesFile ?? DEFAULT_SHAPES_FILE,
    reportWriters: [
      new FileWriter({
        outputDir: resolve(outputDir, 'validation'),
        format: 'turtle',
      }),
    ],
  });

  const stage = new Stage({
    name: 'Linked Art to SCHEMA-AP-NDE',
    itemSelector: new SparqlItemSelector({ query: SELECT_HUMAN_MADE_OBJECTS }),
    executors: MAPPING_QUERIES.map(
      (query) => new SparqlConstructExecutor({ query }),
    ),
    validation: { validator, onInvalid: 'write' },
  });

  const pipeline = new Pipeline({
    name: 'linked-art-to-schema-ap-nde',
    datasetSelector: createLinkedArtDatasetSelector(options),
    distributionResolver,
    stages: [stage],
    writers: new FileWriter({ outputDir, format: 'turtle' }),
    reporter: new ConsoleReporter(),
  });

  return { pipeline, distributionResolver };
}
