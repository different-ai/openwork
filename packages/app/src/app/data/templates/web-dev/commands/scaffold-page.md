---
name: scaffold-page
description: Create a new page with layout, metadata, and loading state
---

Create a new page in this project.

Ask me:
1. What is the route path? (e.g., `/about`, `/blog/[slug]`, `/dashboard/settings`)
2. Does it need authentication? (yes/no)
3. Should it be a Server Component or Client Component?

Then generate:
1. **Page file** (`page.tsx`) with:
   - Exported `metadata` object (title, description, Open Graph)
   - Props interface if it has dynamic params
   - Semantic HTML structure with placeholder content
2. **Loading file** (`loading.tsx`) with a skeleton that matches the page layout
3. **Layout file** (`layout.tsx`) only if this route group needs a shared layout

Follow the project's existing patterns. If no patterns exist, use the web-dev-standards skill.

Output each file with its full path and contents. Do not create the files until I confirm.
