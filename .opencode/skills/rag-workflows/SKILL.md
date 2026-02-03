---
name: rag-workflows
description: Retrieval-Augmented Generation (RAG) workflows for document-based Q&A
---

<!-- //review-2026-02-15 @twishapatel12 -->

## Overview

This skill describes patterns and workflows for **Retrieval-Augmented Generation (RAG)** in OpenWork, with a focus on **local document question answering**.

RAG combines document retrieval with large language models to answer questions grounded in external context rather than relying solely on model knowledge.

This skill is intended to help users design and reason about RAG-style workflows within OpenWork.

## Local RAG with Ollama

A common use case is running RAG **fully locally** using Ollama as the LLM backend. This enables:

- Querying private or sensitive documents  
- Offline experimentation  
- Avoiding external API dependencies  

Typical steps in a local RAG workflow include:
1. Preparing a set of local documents  
2. Retrieving relevant chunks based on a query  
3. Providing retrieved context to a local LLM via Ollama  
4. Generating an answer grounded in the retrieved context  

## Setup (Ollama)

To use the included example workflow, you will need Ollama installed and running locally.

### 1. Install Ollama

Follow the official installation instructions for your platform:
https://ollama.com/download

### 2. Start Ollama

After installation, ensure the Ollama service is running. On most systems, this can be done by simply running:

```bash
ollama serve
````

(or by launching the Ollama app if you installed the desktop version).

### 3. Pull the required model

The example workflow uses **llama3**. Install it with:

```bash
ollama pull llama3
```

You can verify it is available by running:

```bash
ollama list
```

## Included Example

This skill includes a minimal example workflow:

* **local-ollama-doc-qa**

It demonstrates:

* Retrieving context from local documents
* Answering questions using a local Ollama model

## Example Use Cases

* Question answering over local markdown or text files
* Exploring private knowledge bases
* Prototyping RAG pipelines before production deployment

## Notes

* This skill is **optional** and **not enabled by default**
* It becomes available via the Skills settings when present
* This skill currently provides conceptual guidance, patterns, and a minimal runnable example
