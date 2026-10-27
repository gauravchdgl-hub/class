/** Compiles a static stylesheet for every Tailwind utility class used across the EJS views,
 *  replacing the Play CDN (cdn.tailwindcss.com) so pages render correctly even when that
 *  CDN is slow, blocked, or down. See src/public/assets/tailwind.css (generated — do not edit). */
module.exports = {
  content: ['./src/views/**/*.ejs'],
  theme: { extend: {} },
  plugins: [],
};
