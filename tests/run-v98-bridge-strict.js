"use strict";

process.env.PS_AGENT_TEST_VERSION = "v9.8";
process.env.PS_AGENT_REQUIRE_MODELS = "1";
require("./v97-live-bridge-segmentation.test.js");
