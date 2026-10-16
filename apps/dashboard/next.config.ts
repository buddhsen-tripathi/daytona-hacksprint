import type { NextConfig } from "next";
import fs from "node:fs";
import path from "node:path";

for (const f of [path.resolve(__dirname, "../../.env"), path.resolve(__dirname, "../../.env.local")]) {
  if (fs.existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* ignore */
    }
  }
}

const nextConfig: NextConfig = { devIndicators: false, agentRules: false } as NextConfig;
export default nextConfig;
