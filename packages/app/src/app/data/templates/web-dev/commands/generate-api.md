---
name: generate-api
description: Generate a REST API endpoint with validation and error handling
---

Generate a new API endpoint for this project.

Ask me:
1. What resource does this endpoint manage? (e.g., users, products, invoices)
2. Which HTTP methods? (GET, POST, PUT, DELETE — pick one or more)
3. Does it need authentication?
4. What is the data shape? (or should I infer it from existing code?)

Then generate:
1. **Route handler** (`route.ts`) with:
   - Input validation using Zod schemas
   - Proper HTTP status codes (200, 201, 400, 401, 404, 500)
   - Consistent error response shape: `{ error: string, details?: unknown }`
   - TypeScript types for request/response
2. **Zod schema file** if the project uses a shared schemas directory
3. **Type definitions** exported for client-side consumption

Rules:
- Use the project's existing database/ORM pattern (Prisma, Drizzle, raw SQL).
- If no ORM exists, use placeholder functions with `// TODO: implement` comments.
- Never return raw database errors to the client.
- Add rate limiting comments where appropriate.
- Include example `curl` commands in a comment block at the top of the file.

Output each file with its full path. Do not create files until I confirm.
