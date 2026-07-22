# delete-custom-marketplace — Safe custom marketplace deletion

1. Marketplace management stays out of the way until I open the compact actions menu, where Edit and Delete are easy to find.

2. Edit opens a focused form, and saving updates the marketplace name and description through the existing API.

3. Delete never happens immediately. A dedicated confirmation modal gives a clear, neutral warning without exposing implementation details.

4. Only after I explicitly confirm does the marketplace leave the active list and disappear from the API.

5. OpenWork's built-in marketplace has no edit or delete menu and stays protected by the API, so management actions apply only to custom catalogs.
