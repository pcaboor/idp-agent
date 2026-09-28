// The catalogue, a group's page and the relations graph: what the demo shows.
// `app.packages: all` in app-config.yaml installs every plugin this package
// depends on; they are listed here too so that the app reads on its own.
import { createApp } from '@backstage/frontend-defaults';
import catalogPlugin from '@backstage/plugin-catalog/alpha';
import catalogGraphPlugin from '@backstage/plugin-catalog-graph/alpha';
import orgPlugin from '@backstage/plugin-org/alpha';

export default createApp({
  features: [catalogPlugin, catalogGraphPlugin, orgPlugin],
});
