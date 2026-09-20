import { register } from "node:module";
import { pathToFileURL } from "url";
register(pathToFileURL("./scripts/test-loader-hook.mjs"));
