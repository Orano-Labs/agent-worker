#!/usr/bin/env node

const { Generator } = require("../dist/index.cjs");
const { runNodeJs } = require("@bufbuild/protoplugin");

runNodeJs(new Generator().createPlugin());
