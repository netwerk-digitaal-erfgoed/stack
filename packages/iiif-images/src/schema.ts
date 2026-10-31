import type { SearchField, SearchType } from '@lde/search';

const SCHEMA = 'https://schema.org/';
const IIIF = 'https://def.nde.nl/iiif#';

/** One precomputed rendition of the image, with the URL to request it at. */
export const iiifImageSize = {
  name: 'IiifImageSize',
  fields: [
    { name: 'width', kind: 'integer', output: true, path: `${SCHEMA}width` },
    { name: 'height', kind: 'integer', output: true, path: `${SCHEMA}height` },
    {
      name: 'url',
      kind: 'reference',
      output: true,
      path: `${SCHEMA}contentUrl`,
      ref: { strategy: 'idOnly' },
    },
  ],
} as const satisfies SearchType;

/** The IIIF image service itself, for consumers doing deep zoom or region crops. */
export const iiifImageService = {
  name: 'IiifImageService',
  fields: [
    {
      name: 'url',
      kind: 'reference',
      output: true,
      path: `${SCHEMA}url`,
      ref: { strategy: 'idOnly' },
    },
    { name: 'type', kind: 'keyword', output: true, path: `${IIIF}serviceType` },
    { name: 'profile', kind: 'keyword', output: true, path: `${IIIF}profile` },
  ],
} as const satisfies SearchType;

/**
 * The image that represents a work: the full dimensions, and the renditions a
 * consumer can pick from without knowing Image API compliance levels.
 */
export const iiifImage = {
  name: 'IiifImage',
  fields: [
    { name: 'width', kind: 'integer', output: true, path: `${SCHEMA}width` },
    { name: 'height', kind: 'integer', output: true, path: `${SCHEMA}height` },
    {
      name: 'sizes',
      kind: 'reference',
      array: true,
      output: true,
      path: `${IIIF}size`,
      ref: { typeName: iiifImageSize.name, strategy: 'inline' },
    },
    {
      name: 'service',
      kind: 'reference',
      output: true,
      path: `${IIIF}service`,
      ref: { typeName: iiifImageService.name, strategy: 'inline' },
    },
  ],
} as const satisfies SearchType;

/** The types {@link representativeImageField} nests, to add to the schema. */
export const iiifImageTypes = [iiifImage, iiifImageSize, iiifImageService];

/** Add to a root type’s fields, and {@link iiifImageTypes} to the schema, to opt
 *  that type in to enrichment. */
export const representativeImageField = {
  name: 'representativeImage',
  kind: 'reference',
  output: true,
  path: `${IIIF}representativeImage`,
  ref: { typeName: iiifImage.name, strategy: 'inline' },
} as const satisfies SearchField;
