"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_path_1 = __importDefault(require("node:path"));
const testing_1 = require("@iobroker/testing");
// __dirname is build/test/ after compilation, navigate to project root
testing_1.tests.packageFiles(node_path_1.default.join(__dirname, "..", ".."));
//# sourceMappingURL=testPackageFiles.js.map