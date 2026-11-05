import { describe, expect, it } from 'vitest';
import { iiifImageTypes, representativeImageField } from './schema.js';

describe('schema', () => {
  // The indexer’s extraction embeds each `path` as a literal SPARQL property
  // path, so a bare IRI makes its parser throw on the first run.
  const propertyPath = /^<[^<>]+>([/|]<[^<>]+>)*$/;

  it('states every field path as a SPARQL property path', () => {
    const paths = [
      representativeImageField.path,
      ...iiifImageTypes.flatMap((type) =>
        type.fields.map((field) => field.path),
      ),
    ];

    for (const path of paths) {
      expect(path).toMatch(propertyPath);
    }
  });
});
