/** @type {import('next').NextConfig} */
const isStaticExport =
  process.env.CYCLEGEN_STATIC_EXPORT === "1" ||
  process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");

const nextConfig = {
  // Dev browser / automation may hit 127.0.0.1 while the app is opened as localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  ...(basePath ? { basePath } : {}),
  ...(isStaticExport
    ? {
        output: "export",
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
