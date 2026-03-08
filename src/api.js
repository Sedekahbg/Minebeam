// src/api.js
import fetch from "node-fetch";
import { API_BASE } from "./config.js";

async function get(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`API ${path} → HTTP ${res.status}`);
  return res.json();
}

export const getCurrentRound = (addr) =>
  get(addr ? `/api/round/current?user=${addr}` : "/api/round/current");

export const getPrice = () => get("/api/price");

export const getUserRewards = (addr) => get(`/api/user/${addr}/rewards`);
