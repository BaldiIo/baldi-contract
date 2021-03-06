'use strict';

const program = require('commander');

require('pretty-error').start();
require('dotenv').config();

require('./src/commands/build').cmd(program);
require('./src/commands/deploy').cmd(program);
require('./src/commands/deploy-staking-rewards').cmd(program);
require('./src/commands/import-fee-periods').cmd(program);
require('./src/commands/migrate-binary-option-markets').cmd(program);
require('./src/commands/nominate').cmd(program);
require('./src/commands/owner').cmd(program);
require('./src/commands/persist-tokens').cmd(program);
require('./src/commands/purge-synths').cmd(program);
require('./src/commands/release').cmd(program);
require('./src/commands/remove-synths').cmd(program);
require('./src/commands/replace-synths').cmd(program);
require('./src/commands/settle').cmd(program);
require('./src/commands/verify').cmd(program);
require('./src/commands/versions-history').cmd(program);
require('./src/commands/versions-update').cmd(program);
require('./src/commands/fork').cmd(program);
require('./src/commands/prepare-deploy').cmd(program);

require('./src/commands/update-rate').cmd(program);
require('./src/commands/subgraph').cmd(program);
require('./src/commands/eth95').cmd(program);
require('./src/commands/escrow').cmd(program);

program.parse(process.argv);
