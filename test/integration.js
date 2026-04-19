const path = require("node:path");
const { tests } = require("@iobroker/testing");

// Run integration tests — see https://github.com/ioBroker/testing
tests.integration(path.join(__dirname, ".."));
