import { convertPresentation2 } from '@iiif/parser/presentation-2';

/**
 * The image service of a manifest’s first painted image that has one, in either
 * Presentation version.
 *
 * A walk over the plain JSON rather than a vault: real manifests carry shapes a
 * normalising parser rejects outright – Deventit Atlantis writes
 * `"annotations": [null]` – and only this path matters here. Which image
 * represents a work is a rule that lives in this one function, so a better one
 * can replace it without touching what it feeds.
 */
export function selectImageService(manifest: unknown): string | undefined {
  for (const canvas of arrayOf(fieldOf(upgraded(manifest), 'items'))) {
    for (const page of arrayOf(fieldOf(canvas, 'items'))) {
      for (const annotation of arrayOf(fieldOf(page, 'items'))) {
        for (const body of paintedResources(fieldOf(annotation, 'body'))) {
          const service = imageServiceOf(body);
          if (service !== undefined) {
            return service;
          }
        }
      }
    }
  }
  return undefined;
}

/** Whether a document has the canvases every manifest must have, in either version. */
export function listsCanvases(document: unknown): boolean {
  return (
    arrayOf(fieldOf(document, 'items')).length > 0 ||
    arrayOf(fieldOf(document, 'sequences')).length > 0
  );
}

/**
 * The manifest in Presentation 3 terms. A Presentation 2 manifest the upgrade
 * chokes on, such as one with `"images": [null]`, has nothing to find: retrying
 * cannot help, and a run of them must not write off a dataset’s other manifests.
 */
function upgraded(manifest: unknown): unknown {
  if (fieldOf(manifest, 'sequences') === undefined) {
    return manifest;
  }
  try {
    return convertPresentation2(manifest as object);
  } catch {
    return undefined;
  }
}

/** A body’s resources in order, with each `Choice` opened up and each
 *  `SpecificResource`, which is how a cropped painting is stated, unwrapped. */
function paintedResources(body: unknown): unknown[] {
  return arrayOf(body).flatMap((resource) => {
    const type = fieldOf(resource, 'type');
    if (type === 'Choice') {
      return paintedResources(fieldOf(resource, 'items'));
    }
    return type === 'SpecificResource'
      ? paintedResources(fieldOf(resource, 'source'))
      : [resource];
  });
}

function imageServiceOf(resource: unknown): string | undefined {
  for (const service of arrayOf(fieldOf(resource, 'service'))) {
    const id = fieldOf(service, 'id') ?? fieldOf(service, '@id');
    if (typeof id === 'string' && isImageService(service)) {
      return serviceBase(id);
    }
  }
  return undefined;
}

/** The URL `/info.json` and sizes are appended to. Some manifests state the
 *  service with a trailing slash or as the `info.json` itself. */
function serviceBase(id: string): string {
  return id.replace(/\/info\.json$/, '').replace(/\/+$/, '');
}

/**
 * By `type` in Presentation 3, by `profile` where an older service has no
 * specific one – the profile of an Image API service names its compliance level,
 * and Limb Gallery’s is the Stanford URL from Image API 1.1, which the Presentation
 * 2 upgrade does not recognise as an image service.
 */
function isImageService(service: unknown): boolean {
  const type = fieldOf(service, 'type') ?? fieldOf(service, '@type');
  const profile = fieldOf(service, 'profile');
  return (
    (typeof type === 'string' && type.startsWith('ImageService')) ||
    (typeof profile === 'string' && /level[012]/.test(profile))
  );
}

function fieldOf(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[name]
    : undefined;
}

function arrayOf(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}
