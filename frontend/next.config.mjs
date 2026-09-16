/** @type {import('next').NextConfig} */
const nextConfig = {
  // Dev browser / automation may hit 127.0.0.1 while the app is opened as localhost.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
