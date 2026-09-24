/**
 * Backstage's own example entity, as the brief quotes the owner's repository
 * (catalog/apis/api-1.yml): `spec.owner` names a group the way nearly every
 * real catalogue does, with neither kind nor namespace, and `spec.system` is
 * in the same short form. Shared, so every suite reads the one document.
 */
export const ARTIST_WEB = `apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: artist-web
  description: The place to be, for great artists
  labels:
    example.com/custom: custom_label_value
  annotations:
    example.com/service-discovery: artistweb
    circleci.com/project-slug: github/example-org/artist-website
  tags:
    - java
  links:
    - url: https://admin.example-org.com
      title: Admin Dashboard
      icon: dashboard
      type: admin-dashboard
spec:
  type: website
  lifecycle: production
  owner: artist-relations-team
  system: public-websites
`
