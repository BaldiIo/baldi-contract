'use strict';

const path = require('path');
const { gray, green, yellow, red } = require('chalk');
const fs = require('fs');
const yaml = require('js-yaml');
const Mustache = require('mustache');

const {
	ensureNetwork,
	ensureDeploymentPath,
	getDeploymentPathForNetwork,
	stringify,
} = require('../util');
const { program } = require('commander');

const DEFAULTS = {
	network: 'hecot',
	graphPath: path.join(__dirname, '..', '..', '..', '..', 'synthetix-subgraph'),
};
const SUBGRAPHSDIR = 'subgraphs';
const TEMPLATE = `
specVersion: {{specVersion}}
description: {{description}}
repository: {{&repository}}
schema:
  file: {{&schema.file}}
dataSources:
  {{#dataSources}}
  - kind: {{&kind}}
    name: {{name}}
    network: {{network}}
    source:
      address: '{{&source.address}}'
      abi: {{&source.abi}}
      startBlock: {{&source.startBlock}}
    mapping:
      kind: {{&mapping.kind}}
      apiVersion: {{mapping.apiVersion}}
      language: {{&mapping.language}}
      file: {{&mapping.file}}
      entities:
        {{#mapping.entities}}
        - {{.}}
        {{/mapping.entities}}
      abis:
        {{#mapping.abis}}
        - name: {{name}}
          file: {{&file}}
        {{/mapping.abis}}
      eventHandlers:
        {{#mapping.eventHandlers}}
        - event: {{event}}
          handler: {{handler}}
        {{/mapping.eventHandlers}}
        
    {{/dataSources}}
`;

const subgraph = async ({
	network = DEFAULTS.network,
	deploymentPath,
	graphPath = DEFAULTS.graphPath,
	startBlock = 1,
}) => {
	ensureNetwork(network);
	deploymentPath = deploymentPath || getDeploymentPathForNetwork(network);
	const deploymentFile = path.join(deploymentPath, 'deployment.json');
	ensurePath(deploymentFile);
	const deployment = JSON.parse(fs.readFileSync(deploymentFile));

	const YAMLDIR = path.join(graphPath, SUBGRAPHSDIR);
	ensurePath(YAMLDIR);

	// all yaml
	var files = fs.readdirSync(YAMLDIR).filter(f => f.endsWith('.yaml'));
	files.forEach(name => {
		const fileName = path.join(YAMLDIR, name);
		const content = yaml.load(fs.readFileSync(fileName), 'utf-8');
		content.dataSources.forEach(kind => {
			// kind.network
			if (startBlock > 1) {
				kind.source.startBlock = startBlock;
			}
			const beforeAddress = kind.source.address;
			if (kind.name === 'ProxySynthetix' || kind.name === 'Synthetix') {
				kind.source.address = deployment.targets['ProxyERC20'].address;
			} else if (kind.name.startsWith('Synth')) {
				const cName = kind.name.replace('Synth', 'Proxy');
				console.log(`cName => ${cName}, kind.name => ${kind.name}`);
				kind.source.address = deployment.targets[cName].address;
			} else if (deployment.targets[kind.name]) {
				kind.source.address = deployment.targets[kind.name].address;
			} else {
				console.log(yellow(`no match by kind.name ${kind.name}`));
			}
			if (kind.source.address !== beforeAddress) {
				console.log(yellow(`replace ${kind.name} to address ${kind.source.address}`));
			}
		});
		var output = Mustache.render(TEMPLATE, content);
		fs.writeFileSync(fileName, output);
	});
};

const ensurePath = path => {
	if (!fs.existsSync(path)) {
		throw Error(`${path} not exist`);
	}
};

module.exports = {
	subgraph,
	DEFAULTS,
	cmd: program =>
		program
			.command('subgraph')
			.description('replace address to subgraph.yaml')
			.option(
				'-n, --network <value>',
				'The network to run off.',
				x => x.toLowerCase(),
				DEFAULTS.network
			)
			.option(
				'-d, --deployment-path <value>',
				`Path to a folder that has your input configuration file `
			)
			.option('-g, --graph-path <value>', 'Path to a folder that has your graph yaml files ')
			.option('-s, --start-block <value>', 'start block in graph')
			.action(async (...args) => {
				try {
					await subgraph(...args);
				} catch (err) {
					// show pretty errors for CLI users
					console.error(red(err));
					process.exitCode = 1;
				}
			}),
};
