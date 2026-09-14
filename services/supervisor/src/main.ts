process.env.AW_SUPERVISOR_FS_ROOT = "/aw-fs";
process.env.AW_SUPERVISOR_ID = "yunx0i7xgbn7ahes6i3f2r3l";
process.env.AW_SUPERVISOR_PRIVATE_KEY = "302e020100300506032b657004220420d70bb4fd52366fe2f45df5e0e68d5047a42217eaca3605751ea605698f6e2313";
process.env.AW_SUPERVISOR_DIRECTOR_HOST_URL = "http://117.55.235.4:3008";

import("@/application.js").then(({ Application }) => {
  return Application.run();
});
