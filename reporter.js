const fs = require('fs');
const readFiles = require('read-files-promise');
const mustache = require('mustache');
const utils = require('./utils.js');
const chalk = require('chalk');
const getPort = require('get-port');
const WebSocket = require('ws');

/**
 * Generates a report on the status of the tree and runner
 */
class Reporter {
    constructor(tree, runner) {
        this.tree = tree;               // the Tree object to report on
        this.runner = runner;           // the Runner object to report on

        this.serializedTree = '';       // serialized version of this.tree
        this.branchUpdates = [];        // references to branches in this.tree.branches that were updated after this.serializedTree was generated

        this.reportTemplate = "";       // template for html reports
        this.reportTime = null;         // Date when the report was generated
        this.reportPath = process.cwd() + "/report.html"; // absolute path of report.html being generated by this reporter

        this.isReportServer = true;     // whether or not to run the report server
        this.reportDomain = null;       // domain:port where report server's api is available

        this.maxSize = 1073741824;      // maximum permissible size of report, in bytes, no limit if 0 (1 GB default)
        this.size = 0;                  // size of report, in bytes

        this.timer = null;              // timer that goes off when it's time to write the report to disk
        this.stopped = false;           // true if this Reporter was already stopped
    }

    /**
     * Starts the reporter, which generates and writes to disk a new report once every REPORT_GENERATE_FREQUENCY ms
     */
    async start() {
        // Load template
        let buffers = await readFiles(['report-template.html'] , {encoding: 'utf8'});
        if(!buffers || !buffers[0]) {
            utils.error("report-template.html not found in this directory");
        }
        this.reportTemplate = buffers[0];

        await this.write();
    }

    /**
     * Stops the timer set by start()
     */
    async stop() {
        if(!this.stopped) {
            this.stopped = true;
            if(this.timer) {
                clearTimeout(this.timer);
                this.timer = null;
            }
            await this.write(); // one final time, to encompass last-second changes
        }
    }

    /**
     * Writes the report to disk and continues writing to disk periodically
     */
    async write() {
        let reportData = this.generateReport();
        this.size = reportData.length;

        if(this.maxSize > 0 && this.size > this.maxSize) {
            utils.error(`Maximum report size exceeded (report size = ${(this.size/1048576).toFixed(3)} MB, max size = ${this.maxSize/1048576} MB)`);
        }

        await new Promise((res, rej) => fs.writeFile(this.reportPath, reportData, err => err ? rej(err) : res()));

        if(!this.stopped) {
            let REPORT_GENERATE_FREQUENCY = this.size < 300000000 ? 60000 : 300000; // if file size < 300 MB, every min, otherwise every 5 mins
            this.timer = setTimeout(() => this.write(), REPORT_GENERATE_FREQUENCY);
        }
    }

    /**
     * Generates a new html report from this.tree and this.runner, updates this.serializedTree and this.branchUpdates
     * @return {String} The html report that was generated
     */
    generateReport() {
        this.tree.updateCounts();
        this.reportTime = new Date();

        this.serializedTree = this.tree.serialize();
        this.branchUpdates = [];

        let view = {
            tree: utils.escapeHtml(this.serializedTree),
            runner: utils.escapeHtml(this.runner.serialize()),
            reportTime: JSON.stringify(this.reportTime),
            reportDomain: this.reportDomain || ""
        }

        return mustache.render(this.reportTemplate, view);
    }

    /**
     * Reads in the given report html file, extracts json, merges it with tree
     */
    async mergeInLastReport(filename) {
        let lastReportPath = process.cwd() + "/" + filename;
        console.log(`Including passed branches from: ${chalk.gray(lastReportPath)}`);
        console.log("");

        let fileBuffers = null;
        try {
            fileBuffers = await readFiles([ filename ], {encoding: 'utf8'});
        }
        catch(e) {
            utils.error(`The file '${filename}' could not be found`);
        }

        let buffer = fileBuffers[0];
        buffer = this.extractTreeJson(buffer);
        this.tree.markPassedFromPrevRun(buffer);
    }

    /**
     * Extracts the report json from the given html report
     * @param {String} reportData - The raw html report
     * @return {String} The json object extracted from reportData
     * @throws {Error} If there was a problem extracting, or if the JSON is invalid
     */
    extractTreeJson(reportData) {
        const errMsg = "Error parsing the report from last time. Please try another file or do not use -s or --skip-passed.";

        let matches = htmlReport.match(/<div id="tree">([^<]*)<\/div>/);
        if(matches) {
            let content = matches[1];
            content = utils.unescapeHtml(content);
            try {
                JSON.parse(content);
            }
            catch(e) {
                utils.error(errMsg);
            }

            return content;
        }
        else {
            utils.error(errMsg);
        }
    }

    /**
     * Runs WebSocket server
     */
    async runServer() {
        if(!this.isReportServer) {
            return;
        }

        // Set port and fill reportDomain
        let port = null;
        let portConfig = {port: getPort.makeRange(9000,9999)}; // avoid 8000's, since that's where localhost apps tend to be run
        if(this.reportDomain) {
            let matches = this.reportDomain.match(/\:([0-9]+)/);
            if(matches && matches[1]) { // reportDomain has a domain and port
                port = parseInt(matches[1]);
            }
            else { // reportDomain only has a domain
                port = await getPort(portConfig);
                this.reportDomain += ":" + port;
            }
        }
        else { // reportDomain has nothing
            port = await getPort(portConfig);
            this.reportDomain = "ws://localhost:" + port;
        }

        let wsServer = new WebSocket.Server({ port: port });
        //console.log(`Report server running on port ${port}`);

        wsServer.on('connection', (ws) => {
            ws.on('message', (message) => {
                try {
                    // message must be { origin: absolute filename or domain:port of client }
                    message = JSON.parse(message);

                    // Validate that the client is either the current report.html or a page on the reportDomain origin
                    if(!message.origin || (message.origin != this.reportPath && !message.origin.startsWith(this.reportDomain))) {
                        throw new Error(`Invalid filename param`);
                    }

                    // Dump current serialized tree
                    ws.send(this.serializedTree);

                    // Dump branch updates
                    let branchUpdates = this.branchUpdates.map(branch => branch.serialize());
                    ws.send(JSON.serialize(branchUpdates));
                }
                catch(e) {
                    ws.send(e);
                    ws.close();
                }
            });
        });
    }
}
module.exports = Reporter;
