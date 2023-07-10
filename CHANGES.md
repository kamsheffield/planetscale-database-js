# PlanetScale Serverless JavaScript Driver with TypeORM and Cloudflare Workers Support

## About

The PlanetScale Serverless Driver does not work with TypeORM or Cloudflare Workers out of the box. In order to get it working with these technologies the following changes where made:

### TypeORM 

When trying to import the PlanetScale driver in the TypeORM codebase the following error is produced: `Error [ERR_REQUIRE_ESM]: require() of ES Module not supported`. Using a dynamic import like `await import('@planetscale/database')` which is the common soluition online produced the same error. In addition, other tricks to get it working which relied on code generation were not compatible with Cloudflare which does not allow this. In the end the solution was to build this as a CommonJS module rather than an ESM.

### Cloudfare 

Currently Cloudflare Workers does not have the `cache` field implemented in the fetch call. The PlanetScale team recently added the `cache` field to explicitly disable all caching when interacting with the database. See the following links:
  
  * Issue: https://github.com/planetscale/database-js/issues/101
  * Change: https://github.com/planetscale/database-js/pull/102
  * Bug: https://github.com/cloudflare/workerd/issues/698

Once Cloudflare has fixed the bug the `cache` field should be added back in. **Note** I had to add the `RequestCache` type to `types.ts` for this to work in TypeORM.

`export type RequestCache = "default" | "force-cache" | "no-cache" | "no-store" | "only-if-cached" | "reload";`

### Additional Changes

* The driver was not forwarding all of the exceptions which made debugging difficult, so a check was added to throw `exception.cause` if an exception is thrown and it is present.

## Developing

### Build

`npm run build`

### Build and Test

`npm test`

See the README.md for more information.

## Repository

### Branching

* **main**: Tracks the main branch from upstream: `git@github.com:planetscale/database-js.git`
* **typeorm-cloudflare**: Contains the changes to `@planetscale/database` for compatibility with TypeORM on Cloudflare Workers.

### Integration

* Checkout `main` and pull the latest upstream `main`.
* Create a new `integration` branch off of `typeorm-cloudflare` and merge the changes from `main`. 
* Fix any conflicts as needed.
* Run the build and the tests to ensure everything seems to be working.
* Merge the changes into `typeorm-cloudflare`.

### Distribution

* Create new release tag
* `npm test`
* `npm pack`
* Upload package to github
