import { createTestDataDir } from "./helpers/dir";

const dir = createTestDataDir();
process.env.DATA_DIR = dir;
process.env.ADMIN_USERNAME = "test_admin";
process.env.ADMIN_PASSWORD = "test_password123!";

export default () => {
  // noop
};