import { Pipeline } from '@lde/pipeline';
import { buildPipeline } from './build-pipeline.js';
import {
  CONSTRUCT_CREATIVE_WORK,
  MAPPING_QUERIES,
  SELECT_HUMAN_MADE_OBJECTS,
} from './queries.js';

describe('buildPipeline', () => {
  it('wires a runnable pipeline and its import resolver', async () => {
    const { pipeline, distributionResolver } = await buildPipeline({
      outputDir: 'tmp/test-output',
    });

    expect(pipeline).toBeInstanceOf(Pipeline);
    expect(distributionResolver).toBeDefined();
  });
});

describe('mapping queries', () => {
  it('selects Linked Art objects with the ?this variable the readers expect', () => {
    expect(SELECT_HUMAN_MADE_OBJECTS).toMatch(/SELECT\s+\?this/);
    expect(SELECT_HUMAN_MADE_OBJECTS).toContain('crm:E22_Human-Made_Object');
  });

  it('projects into SCHEMA-AP-NDE schema:CreativeWork', () => {
    expect(MAPPING_QUERIES).toContain(CONSTRUCT_CREATIVE_WORK);
    expect(CONSTRUCT_CREATIVE_WORK).toContain('a schema:CreativeWork');
    expect(CONSTRUCT_CREATIVE_WORK).toContain('https://schema.org/');
  });

  it('uses UNION rather than OPTIONAL to avoid cross-product duplicates', () => {
    expect(CONSTRUCT_CREATIVE_WORK).toContain('UNION');
    expect(CONSTRUCT_CREATIVE_WORK).not.toContain('OPTIONAL');
  });
});
