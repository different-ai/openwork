# delete-custom-marketplace — Safe custom marketplace deletion

1. Marketplace management stays out of the way until I open the compact actions menu, where Edit and Delete are easy to find.

2. Edit opens a focused form, and saving updates the marketplace name and description through the existing API.

3. Delete never happens immediately. A dedicated confirmation modal explains exactly what changes and what OpenWork preserves.

4. Only after I explicitly confirm does the marketplace leave the active list, while the API records a reversible soft-delete and keeps plugin history intact.

5. OpenWork's built-in marketplace stays protected in both the interface and API, so the destructive action applies only to manually managed catalogs.
