import { AnyJson } from "@salesforce/ts-types";
import fs from "fs-extra";
import { core, flags, SfdxCommand } from "@salesforce/command";
import rimraf = require("rimraf");
import { AsyncResult, DeployResult } from "jsforce";
import { AsyncResource } from "async_hooks";
import { SfdxError } from "@salesforce/core";
import xml2js = require("xml2js");
import util = require("util");
// tslint:disable-next-line:ordered-imports
var jsforce = require("jsforce");
var path = require("path");
import { checkRetrievalStatus } from "../../../../shared/checkRetrievalStatus";
import { checkDeploymentStatus } from "../../../../shared/checkDeploymentStatus";
import { extract } from "../../../../shared/extract";
import { zipDirectory } from "../../../../shared/zipDirectory";

// Initialize Messages with the current plugin directory
core.Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = core.Messages.loadMessages(
  "sfpowerkit",
  "duplicaterule_activate"
);

export default class Activate extends SfdxCommand {
  public connectedapp_consumerKey: string;
  public static description = messages.getMessage("commandDescription");

  public static examples = [
    `$ sfdx sfpowerkit:org:duplicaterule:Activate -n Account.CRM_Account_Rule_1 -u sandbox
    Polling for Retrieval Status
    Retrieved Duplicate Rule  with label : CRM Account Rule 2
    Preparing Activation
    Deploying Activated Rule with ID  0Af4Y000003OdTWSA0
    Polling for Deployment Status
    Polling for Deployment Status
    Duplicate Rule CRM Account Rule 2 Activated
  `
  ];

  protected static flagsConfig = {
    name: flags.string({
      required: true,
      char: "n",
      description: messages.getMessage("nameFlagDescription")
    })
  };

  // Comment this out if your command does not require an org username
  protected static requiresUsername = true;

  public async run(): Promise<AnyJson> {
    rimraf.sync("temp_sfpowerkit");

    //Connect to the org
    await this.org.refreshAuth();
    const conn = this.org.getConnection();
    const apiversion = await conn.retrieveMaxApiVersion();

    let retrieveRequest = {
      apiVersion: apiversion
    };

    //Retrieve Duplicate Rule
    retrieveRequest["singlePackage"] = true;
    retrieveRequest["unpackaged"] = {
      types: { name: "DuplicateRule", members: this.flags.name }
    };
    conn.metadata.pollTimeout = 60;
    let retrievedId;
    await conn.metadata.retrieve(retrieveRequest, function(
      error,
      result: AsyncResult
    ) {
      if (error) {
        return console.error(error);
      }
      retrievedId = result.id;
    });

    let metadata_retrieve_result = await checkRetrievalStatus(
      conn,
      retrievedId
    );
    if (!metadata_retrieve_result.zipFile)
      throw new SfdxError("Unable to find the requested Duplicate Rule");

    //Extract Duplicate Rule
    var zipFileName = "temp_sfpowerkit/unpackaged.zip";
    fs.mkdirSync("temp_sfpowerkit");
    fs.writeFileSync(zipFileName, metadata_retrieve_result.zipFile, {
      encoding: "base64"
    });
    await extract("temp_sfpowerkit");
    fs.unlinkSync(zipFileName);
    let resultFile = `temp_sfpowerkit/duplicateRules/${this.flags.name}.duplicateRule`;

    if (fs.existsSync(path.resolve(resultFile))) {
      const parser = new xml2js.Parser({ explicitArray: false });
      const parseString = util.promisify(parser.parseString);

      let retrieved_duplicaterule = await parseString(
        fs.readFileSync(path.resolve(resultFile))
      );

      this.ux.log(
        `Retrieved Duplicate Rule  with label : ${retrieved_duplicaterule.DuplicateRule.masterLabel}`
      );

      //Do Nothing if its already Active
      if (retrieved_duplicaterule.DuplicateRule.isActive === "true") {
        this.ux.log("Already Active, exiting");
        return { status: 1 };
      }
      //Deactivate Rule
      this.ux.log(`Preparing Activation`);
      retrieved_duplicaterule.DuplicateRule.isActive = "true";
      let builder = new xml2js.Builder();
      var xml = builder.buildObject(retrieved_duplicaterule);
      fs.writeFileSync(resultFile, xml);

      var zipFile = "temp_sfpowerkit/package.zip";
      await zipDirectory("temp_sfpowerkit", zipFile);

      //Deploy Rule
      conn.metadata.pollTimeout = 300;
      let deployId: AsyncResult;

      var zipStream = fs.createReadStream(zipFile);
      await conn.metadata.deploy(
        zipStream,
        { rollbackOnError: true, singlePackage: true },
        function(error, result: AsyncResult) {
          if (error) {
            return console.error(error);
          }
          deployId = result;
        }
      );

      this.ux.log(`Deploying Activated Rule with ID  ${deployId.id}`);
      let metadata_deploy_result: DeployResult = await checkDeploymentStatus(
        conn,
        deployId.id
      );

      if (!metadata_deploy_result.success)
        throw new SfdxError("Unable to deploy the Activated rule");

      this.ux.log(
        `Duplicate Rule ${retrieved_duplicaterule.DuplicateRule.masterLabel} Activated`
      );

      return { status: 1 };
    } else {
      throw new SfdxError("Duplicate Rule not found in the org");
    }
  }
}
