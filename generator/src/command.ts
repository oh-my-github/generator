/// <reference path="../../typings/node/node.d.ts" />
/// <reference path="../../typings/chalk/chalk.d.ts" />
/// <reference path="../../typings/lodash/lodash.d.ts" />
/// <reference path="../../typings/fs-extra/fs-extra.d.ts" />
/// <reference path="../../typings/commander/commander.d.ts" />
/// <reference path="../../typings/circular-json/circular-json.d.ts" />

"use strict";

import * as _ from "lodash";
import * as CircularJSON from "circular-json";
import * as fse from "fs-extra";
import {
  red as chalkRed, blue as chalkBlue, green as chalkGreen,
  yellow as chalkYellow, magenta as chalkMagenta, bold as chalkBold
} from "chalk";

import {BS_OPTION} from "./file_util";

let path        = require("path");
let pretty      = require("prettyjson");
let browserSync = require("browser-sync");
const bs = browserSync.create();

import { FileUtil, GENERATOR_VERSION, FILE_PATH_PROFILE_TEMPLATE_JSON } from "./file_util";
import {
  GithubUser, GithubEvent,
  LanguageInformation, LanguageSummary,
  Repository, RepositorySummary
} from "./github_model";
import {GithubUtil} from "./github_util";
import {deserialize, deserializeAs, Deserializable} from "./serialize";
import {Profile} from "./profile";

export class OptionSetting {
  constructor(public specifiers: string, public description: string) {}
}

export class GenerateOptions {
  public static GENERATE_OPTION_SPECIFIER_IGNORE_REPOS = "-i, --ignore [repository...]";
  public static GENERATE_OPTION_IGNORE_REPOS = new OptionSetting(
    GenerateOptions.GENERATE_OPTION_SPECIFIER_IGNORE_REPOS, "ignore specified repositories");

  ignore: Array<string>;
}

export class CommandSetting {
  constructor(public specifiers: string,
              public description: string,
              public action: (...args: any[]) => void,
              public alias?: string) {}

  public static COMMAND_INIT = new CommandSetting(
    `init <user> <repo>`,
    "initialize `oh-my-github.json`",
    function(user: string, repo: string) {
      let profPath = FileUtil.getProfilePath();
      let prof = Profile.deserialize(Profile, FileUtil.readFileIfExist(FILE_PATH_PROFILE_TEMPLATE_JSON));
      prof._$meta.github_repository = repo;
      prof._$meta.github_user = user;

      try {
        FileUtil.writeFileIfNotExist(profPath, prof);
      } catch (err) {
        console.log(`${chalkRed("Cannot create file: ")} ${chalkBold(path)}`);
        console.error(`\n${err.stack}`);
      }
    }
  );

  public static COMMAND_GENERATE = new CommandSetting(
    `generate <token> [ignoredRepos...]`,
    "fill `oh-my-github.json` using github API",
    function(token: string, ignoredRepos: Array<string>, options: GenerateOptions) {
      let profPath = FileUtil.getProfilePath();
      let prevProf: Profile = FileUtil.readFileIfExist(profPath);

      // TODO: check meta

      createProfile(token, prevProf._$meta.github_user, ignoredRepos, options)
        .then(currentProf => {

          let uniqActs = GithubEvent.mergeByEventId(prevProf.activities, currentProf.activities);

          console.log(`previous Profile Activity: ${prevProf.activities.length}`);
          console.log(`current  Profile Activity: ${currentProf.activities.length}`);
          console.log(`unique   Profile Activity: ${uniqActs.length}`);

          currentProf.updateMeta(prevProf._$meta);
          currentProf.activities = uniqActs;    /* ㄱset unique activities */
          FileUtil.overwriteFile(profPath, currentProf);
        })
        .catch(err => {
          console.log(`${chalkRed("Cannot create profile\n")} ${chalkBold(path)}`);
          console.error(`\n${err.stack}`);
        });
    }
  );

  public static COMMAND_PREVIEW = new CommandSetting(
    `preview`,
    "preview your github profile",
    function() {
      /** assert if a profile json exists */
      FileUtil.readFileIfExist(FileUtil.getProfilePath());
      bs.init(BS_OPTION);
    }
  );

}

export class ParsedOption {
  @deserialize public flags: string;
  @deserialize public required: number;
  @deserialize public optional: number;
  @deserialize public bool: boolean;
  @deserialize public short: string;
  @deserialize public long: string;
  @deserialize public description: string;
}

export class ParsedCommand extends Deserializable {
  @deserializeAs("_name") public name: string;
  @deserializeAs("_description") public description: string;
  @deserializeAs(ParsedCommand) public commands: Array<ParsedCommand>;
  @deserializeAs(ParsedOption) public options: Array<ParsedOption>;
}

export class CommandFactory {
  public static create(argv: string[]): ParsedCommand {
    let parser = require("commander");

    const PROGRAM_NAME = "omg";

    process.title = PROGRAM_NAME;
    parser._name = PROGRAM_NAME;
    parser.version(GENERATOR_VERSION);

    parser
      .command(CommandSetting.COMMAND_INIT.specifiers)
      .description(CommandSetting.COMMAND_INIT.description)
      .action(CommandSetting.COMMAND_INIT.action);

    parser
      .command(CommandSetting.COMMAND_GENERATE.specifiers)
      .description(CommandSetting.COMMAND_GENERATE.description)
      //.option(GenerateOptions.GENERATE_OPTION_IGNORE_REPOS.specifiers, GenerateOptions.GENERATE_OPTION_IGNORE_REPOS.description)
      .action(CommandSetting.COMMAND_GENERATE.action);

    parser
      .command(CommandSetting.COMMAND_PREVIEW.specifiers)
      .description(CommandSetting.COMMAND_PREVIEW.description)
      .action(CommandSetting.COMMAND_PREVIEW.action);

    parser
      .on("--help", () => {
        console.log("  Examples:");
        console.log("");
        console.log("    $ omg init 1ambda oh-my-github");
        console.log("    $ omg generate 1b94910adb394014939fal1bfd193bfd762c4191");
        console.log("    $ omg preview");
        console.log("");
      });

    /** use circular-json to avoid cyclic references */
    let serialized = CircularJSON.stringify(parser.parse(argv));
    let circularDeserialized = CircularJSON.parse(serialized);
    let deserialized = ParsedCommand.deserialize(ParsedCommand, circularDeserialized);
    return deserialized;
  }
}

function printProfile(user: GithubUser,
                      langInfos: Array<LanguageInformation>,
                      repos: Array<Repository>,
                      acts: Array<GithubEvent>): void {

  /** debug info */
  console.log(`\n${chalkBlue("[USER]")}`);
  console.log(pretty.render(user));

  console.log(`\n${chalkBlue("[LANGUAGE]")}`);

  if (!_.isEmpty(langInfos)) {
    let langSet = langInfos.reduce((acc, langInfo) => {
      if (_.isEmpty(langInfo.languages) || langInfo.languages.length === 0) return acc;

      langInfo.languages.map(lang => lang.name).forEach(name => {
        acc.add(name);
      });

      return acc;
    }, new Set<string>());

    console.log(`Language Count: ${langSet.size}`);
    console.log(`Supported Languages: ${Array.from(langSet).join(", ")}`);
  }

  console.log(`\n${chalkBlue("[REPOSITORY]")}`);
  if (!_.isEmpty(repos)) {
    let repoSummary = new RepositorySummary();
    repos.reduce((sum, repo) => {
      sum.repository_names.push(repo.name);
      sum.repository_count += 1;
      sum.watchers_count += repo.watchers_count;
      sum.stargazers_count += repo.stargazers_count;
      sum.forks_count += repo.forks_count;

      return sum;
    }, repoSummary);

    console.log(`Repository Count: ${repoSummary.repository_count}`);
  }

  console.log(`\n${chalkBlue("[ACTIVITY]")}`);
}

async function createProfile(token: string,
                             user: string,
                             ignoredRepos: Array<string>,
                             options: GenerateOptions): Promise<Profile> {

  let githubUser = await GithubUtil.getGithubUser(token, user);
  let repos = await GithubUtil.getUserRepositories(token, user);
  let langs = await GithubUtil.getUserLanguages(token, user);
  let acts = await GithubUtil.getUserActivities(token, user);

  // TODO: add repo name to language
  printProfile(githubUser, langs, repos, acts);

  let profile = new Profile();
  profile.user = githubUser;
  profile.languages = langs;
  profile.repositories = repos;
  profile.activities = acts;

  return profile;
}

