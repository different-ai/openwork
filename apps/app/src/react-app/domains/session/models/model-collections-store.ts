import { create } from "zustand";

import type { ModelRef } from "@/app/types";

const STORAGE_KEY = "openwork.modelCollections.v1";
export const MAX_RECENT_MODELS = 5;

type StoredCollections = {
  favorites: ModelRef[];
  recent: ModelRef[];
};

type ModelCollectionsStore = StoredCollections & {
  toggleFavorite: (model: ModelRef) => void;
  recordRecent: (model: ModelRef) => void;
};

export function modelRefKey(model: ModelRef) {
  return `${model.providerID}:${model.modelID}`;
}

function isModelRef(value: unknown): value is ModelRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const providerID = Reflect.get(value, "providerID");
  const modelID = Reflect.get(value, "modelID");
  return typeof providerID === "string" && Boolean(providerID.trim())
    && typeof modelID === "string" && Boolean(modelID.trim());
}

function uniqueModels(models: readonly ModelRef[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = modelRefKey(model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readStoredCollections(): StoredCollections {
  if (typeof window === "undefined") return { favorites: [], recent: [] };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { favorites: [], recent: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { favorites: [], recent: [] };
    const favorites = Reflect.get(parsed, "favorites");
    const recent = Reflect.get(parsed, "recent");
    return {
      favorites: uniqueModels(Array.isArray(favorites) ? favorites.filter(isModelRef) : []),
      recent: uniqueModels(Array.isArray(recent) ? recent.filter(isModelRef) : []).slice(0, MAX_RECENT_MODELS),
    };
  } catch {
    return { favorites: [], recent: [] };
  }
}

function writeStoredCollections(collections: StoredCollections) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(collections));
  } catch {
    // Ignore storage failures.
  }
}

export function toggleFavoriteModels(favorites: readonly ModelRef[], model: ModelRef) {
  const key = modelRefKey(model);
  return favorites.some((favorite) => modelRefKey(favorite) === key)
    ? favorites.filter((favorite) => modelRefKey(favorite) !== key)
    : [...favorites, model];
}

export function recordRecentModel(recent: readonly ModelRef[], model: ModelRef) {
  const key = modelRefKey(model);
  return [model, ...recent.filter((entry) => modelRefKey(entry) !== key)].slice(0, MAX_RECENT_MODELS);
}

export function nextFavoriteModel(favorites: readonly ModelRef[], current: ModelRef | null) {
  if (favorites.length === 0) return null;
  const currentKey = current ? modelRefKey(current) : "";
  const currentIndex = favorites.findIndex((favorite) => modelRefKey(favorite) === currentKey);
  if (currentIndex === -1) return favorites[0] ?? null;
  const next = favorites[(currentIndex + 1) % favorites.length] ?? null;
  return next && modelRefKey(next) !== currentKey ? next : null;
}

export const useModelCollectionsStore = create<ModelCollectionsStore>((set) => ({
  ...readStoredCollections(),
  toggleFavorite: (model) => set((state) => {
    const favorites = toggleFavoriteModels(state.favorites, model);
    writeStoredCollections({ favorites, recent: state.recent });
    return { favorites };
  }),
  recordRecent: (model) => set((state) => {
    const recent = recordRecentModel(state.recent, model);
    writeStoredCollections({ favorites: state.favorites, recent });
    return { recent };
  }),
}));
