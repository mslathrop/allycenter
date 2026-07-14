import deckyPlugin from "@decky/rollup";
import replace from "@rollup/plugin-replace";

const buildTimestamp = new Date().toISOString();

export default deckyPlugin({
  input: "src/index.tsx",
  plugins: [
    replace({
      preventAssignment: true,
      values: {
        __ALLY_CENTER_BUILD_TIMESTAMP__: buildTimestamp,
      },
    }),
  ],
  output: {
    dir: "dist",
    format: "esm",
    sourcemap: true,
  },
});
