---
name: pdf-reading
description: Efficient PDF text extraction without Chrome screenshots
---

## Why this skill exists

Using Chrome MCP `take_screenshot` to read PDFs causes **HTTP 413 context overflow** because each page screenshot is a large base64 image. This skill defines the correct approach: extract text directly using lightweight CLI tools.

## Hard rule

**`take_screenshot` must NEVER be used for PDF reading.** Chrome screenshots are a last resort only, and only for PDFs with 5 or fewer pages where all text extraction methods have failed.

## Preferred extraction order

Try these methods in order. Stop as soon as one succeeds.

### 1. pdftotext (best for text-heavy PDFs)

Check availability:
```bash
which pdftotext
```

Install if missing:
```bash
# macOS
brew install poppler

# Debian/Ubuntu
sudo apt-get install poppler-utils

# Fedora/RHEL
sudo dnf install poppler-utils
```

Extract text:
```bash
pdftotext -layout "document.pdf" -  # stdout
pdftotext -layout "document.pdf" "document.txt"  # to file
```

### 2. pdftohtml (preserves structure)

Check availability:
```bash
which pdftohtml
```

Install: same as pdftotext (part of poppler-utils).

Extract:
```bash
pdftohtml -stdout -noframes "document.pdf"
```

### 3. pdftoppm (for image-heavy PDFs) - PAGE AT A TIME

**Critical**: Process one page at a time to avoid context overflow.

Check availability:
```bash
which pdftoppm
```

Install: same as pdftotext (part of poppler-utils).

Page-at-a-time workflow:
```bash
# Get page count first
pdfinfo "document.pdf" | grep Pages

# Process each page individually
for page in $(seq 1 $PAGE_COUNT); do
  pdftoppm -png -f $page -l $page "document.pdf" page_$page
  # Read and summarize page_$page-1.png
  # Delete the image BEFORE processing the next page
  rm page_$page-1.png
done
```

### 4. Python pypdf fallback

Use when CLI tools are unavailable:

```python
from pypdf import PdfReader

reader = PdfReader("document.pdf")
for i, page in enumerate(reader.pages):
    text = page.extract_text()
    print(f"--- Page {i+1} ---")
    print(text)
```

Install: `pip install pypdf`

### 5. Last resort: Chrome screenshot (ONLY if all above fail AND PDF has 5 or fewer pages)

Before using Chrome:
1. Confirm pdftotext, pdftohtml, pdftoppm, and pypdf all failed
2. Confirm PDF has 5 or fewer pages
3. Process ONE page at a time
4. Delete each screenshot before capturing the next

## Checklist before reading a PDF

1. Is it actually a PDF? (check extension and MIME type)
2. Do I have poppler-utils installed? (`which pdftotext`)
3. How many pages? (`pdfinfo document.pdf | grep Pages`)
4. For large PDFs (>10 pages): process in chunks, summarize each chunk, discard raw text before next chunk
5. Never accumulate full PDF content in context

## References

- poppler-utils: https://poppler.freedesktop.org/
- pypdf: https://pypdf.readthedocs.io/
