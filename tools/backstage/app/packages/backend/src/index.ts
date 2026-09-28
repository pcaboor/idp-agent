// Four plugins and nothing else: the app's pages, sign-in, and the catalogue.
// No scaffolder, search, techdocs, kubernetes, proxy or permission backend:
// the demo shows the catalogue a declarations repository fills, and what idpa
// reads from it (tools/backstage/README.md).
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Serves the built frontend on the backend's own port, 7007.
backend.add(import('@backstage/plugin-app-backend'));

// Guest sign-in, a demo convenience (auth.providers.guest in app-config.yaml).
backend.add(import('@backstage/plugin-auth-backend'));
backend.add(import('@backstage/plugin-auth-backend-module-guest-provider'));

// The catalogue: GET /api/catalog/entities/by-query and /entity-facets are
// what idpa reads, with the static token of backend.auth.externalAccess.
backend.add(import('@backstage/plugin-catalog-backend'));

backend.start();
