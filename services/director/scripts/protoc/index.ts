import { runNodeJs } from "@bufbuild/protoplugin";
import { Generator } from "./generator";

runNodeJs(new Generator().createPlugin());
