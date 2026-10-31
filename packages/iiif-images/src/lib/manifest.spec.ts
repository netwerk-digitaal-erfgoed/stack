import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { selectImageService } from './manifest.js';

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../test/fixtures/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}

describe('selectImageService', () => {
  it.each([
    // Presentation 2, with a static manifest thumbnail that has no service.
    ['gouda', 'https://www.goudatijdmachine.nl/omeka/iiif/2/98634'],
    // Presentation 2, with a service URL carrying a query string.
    [
      'limb',
      'https://demo.limb-gallery.com/i/?IIIF=/7b/2e/bc/4c/7b2ebc4c-1a55-4d5d-a154-8b590764caa6/iiif/Van_Gogh_-_Starry_Night_-_Google_Art_Project.tif',
    ],
    // Presentation 3, on another host than the manifest.
    ['ark11978', 'https://ndeiiif.adlibhosting.com/iiif/3/Q110996022.43856'],
    // Presentation 3, with `"annotations": [null]`, which stricter parsers reject.
    ['fehac', 'https://fehac.hosting.deventit.net/IIIF/image/3.0/ic:158'],
  ])('selects the first painted image service of %s', (name, service) => {
    expect(selectImageService(fixture(name))).toBe(service);
  });

  it('looks inside a Choice', () => {
    expect(
      selectImageService(
        manifestPainting({
          type: 'Choice',
          items: [
            {
              type: 'Image',
              service: [
                { id: 'https://example.org/iiif/a', type: 'ImageService3' },
              ],
            },
          ],
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it('looks inside a SpecificResource, as a cropped painting is stated', () => {
    expect(
      selectImageService(
        manifestPainting({
          type: 'SpecificResource',
          source: {
            type: 'Image',
            service: [
              { id: 'https://example.org/iiif/a', type: 'ImageService3' },
            ],
          },
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it.each([
    ['a trailing slash', 'https://example.org/iiif/a/'],
    ['the info.json itself', 'https://example.org/iiif/a/info.json'],
  ])('normalises a service stated with %s', (_shape, id) => {
    expect(
      selectImageService(
        manifestPainting({
          type: 'Image',
          service: [{ id, type: 'ImageService3' }],
        }),
      ),
    ).toBe('https://example.org/iiif/a');
  });

  it('finds nothing in a Presentation 2 manifest the upgrade rejects', () => {
    expect(
      selectImageService({
        '@type': 'sc:Manifest',
        sequences: [{ canvases: [{ images: [null] }] }],
      }),
    ).toBeUndefined();
  });

  it('skips a painted image without a service', () => {
    expect(
      selectImageService({
        type: 'Manifest',
        items: [
          canvasPainting({ type: 'Image', id: 'https://example.org/a.jpg' }),
          canvasPainting({
            type: 'Image',
            service: [
              { id: 'https://example.org/iiif/b', type: 'ImageService2' },
            ],
          }),
        ],
      }),
    ).toBe('https://example.org/iiif/b');
  });

  it('ignores a service that is not an image service', () => {
    expect(
      selectImageService(
        manifestPainting({
          type: 'Image',
          service: [
            { id: 'https://example.org/auth', type: 'AuthProbeService2' },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('finds nothing in a manifest with no image service', () => {
    expect(
      selectImageService(
        manifestPainting({
          type: 'Image',
          id: 'https://example.org/a.jpg',
        }),
      ),
    ).toBeUndefined();
  });

  it('finds nothing in what is not a manifest', () => {
    expect(selectImageService({ hello: 'world' })).toBeUndefined();
    expect(selectImageService(null)).toBeUndefined();
  });
});

function manifestPainting(body: unknown): unknown {
  return { type: 'Manifest', items: [canvasPainting(body)] };
}

function canvasPainting(body: unknown): unknown {
  return {
    type: 'Canvas',
    items: [{ type: 'AnnotationPage', items: [{ type: 'Annotation', body }] }],
  };
}
