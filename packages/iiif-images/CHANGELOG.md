## 0.1.2 (2026-11-10)

### 🚀 Features

- **iiif-images:** count what became of each manifest and image service ([#78](https://github.com/netwerk-digitaal-erfgoed/stack/pull/78))

## 0.1.1 (2026-11-05)

### 🩹 Fixes

- **iiif-images:** accept any @lde/search from 0.36 ([#74](https://github.com/netwerk-digitaal-erfgoed/stack/pull/74))

## 0.1.0 (2026-11-05)

### 🚀 Features

- ⚠️ **iiif-images:** represent works by static images too ([#71](https://github.com/netwerk-digitaal-erfgoed/stack/pull/71))

### ⚠️ Breaking Changes

- **iiif-images:** represent works by static images too ([#71](https://github.com/netwerk-digitaal-erfgoed/stack/pull/71))
  IiifImage has a url field. A schema whose own IiifImage type
  lacks it gets no enrichment; take iiifImageTypes from @ndes/iiif-images/schema
  again and regenerate."
  M packages/iiif-images/README.md
  M packages/iiif-images/package.json
  M packages/iiif-images/src/lib/iiif-images.spec.ts
  M packages/iiif-images/src/lib/iiif-images.ts
  M packages/iiif-images/src/schema.ts
  M pnpm-lock.yaml
  M pnpm-workspace.yaml

## 0.0.1 (2026-11-05)

### 🚀 Features

- **iiif-images:** add representative image enrichment for the search indexer ([#55](https://github.com/netwerk-digitaal-erfgoed/stack/pull/55))

### 🩹 Fixes

- **iiif-images:** state field paths as SPARQL property paths ([#67](https://github.com/netwerk-digitaal-erfgoed/stack/pull/67))
