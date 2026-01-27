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

## Example Use Cases

- Question answering over local markdown or text files
- Exploring private knowledge bases
- Prototyping RAG pipelines before production deployment

## Notes

- This skill is **optional** and **not enabled by default**
- It becomes available via the Skills settings when present
- This skill currently provides conceptual guidance and patterns rather than executable workflows
