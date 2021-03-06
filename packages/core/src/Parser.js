const cheerio = require('cheerio');
const htmlparser = require('htmlparser2'); require('./patches/htmlparser2');
const path = require('path');
const Promise = require('bluebird');
const slugify = require('@sindresorhus/slugify');
const componentParser = require('./parsers/componentParser');
const componentPreprocessor = require('./preprocessors/componentPreprocessor');
const logger = require('./utils/logger');

const _ = {};
_.clone = require('lodash/clone');
_.cloneDeep = require('lodash/cloneDeep');
_.hasIn = require('lodash/hasIn');
_.isArray = require('lodash/isArray');
_.isEmpty = require('lodash/isEmpty');

const md = require('./lib/markdown-it');
const utils = require('./utils');

cheerio.prototype.options.decodeEntities = false; // Don't escape HTML entities

class Parser {
  constructor(config) {
    this.variablePreprocessor = config.variablePreprocessor;
    this.dynamicIncludeSrc = [];
    this.staticIncludeSrc = [];
    this.missingIncludeSrc = [];
  }

  getDynamicIncludeSrc() {
    return _.clone(this.dynamicIncludeSrc);
  }

  getStaticIncludeSrc() {
    return _.clone(this.staticIncludeSrc);
  }

  getMissingIncludeSrc() {
    return _.clone(this.missingIncludeSrc);
  }

  static processDynamicResources(context, html, config) {
    const $ = cheerio.load(html);

    function getAbsoluteResourcePath(elem, relativeResourcePath) {
      const firstParent = elem.closest('div[data-included-from], span[data-included-from]');
      const originalSrc = utils.ensurePosix(firstParent.attr('data-included-from') || context);
      const originalSrcFolder = path.posix.dirname(originalSrc);
      const fullResourcePath = path.posix.join(originalSrcFolder, relativeResourcePath);
      const resolvedResourcePath = path.posix.relative(utils.ensurePosix(config.rootPath), fullResourcePath);
      return path.posix.join(config.baseUrl || '/', resolvedResourcePath);
    }

    $('img, pic, thumbnail').each(function () {
      const elem = $(this);
      if (!elem.attr('src')) {
        return;
      }
      const resourcePath = utils.ensurePosix(elem.attr('src'));
      if (path.isAbsolute(resourcePath) || utils.isUrl(resourcePath)) {
        // Do not rewrite.
        return;
      }
      const absoluteResourcePath = getAbsoluteResourcePath(elem, resourcePath);
      $(this).attr('src', absoluteResourcePath);
    });
    $('a, link').each(function () {
      const elem = $(this);
      const resourcePath = elem.attr('href');
      if (resourcePath === undefined || resourcePath === '') {
        // Found empty href resource in resourcePath
        return;
      }
      if (path.isAbsolute(resourcePath) || utils.isUrl(resourcePath) || resourcePath.startsWith('#')) {
        // Do not rewrite.
        return;
      }
      const absoluteResourcePath = getAbsoluteResourcePath(elem, resourcePath);
      $(this).attr('href', absoluteResourcePath);
    });
    return $.html();
  }

  static unwrapIncludeSrc(html) {
    const $ = cheerio.load(html);
    $('div[data-included-from], span[data-included-from]').each(function () {
      $(this).replaceWith($(this).contents());
    });
    return $.html();
  }

  _parse(node, config) {
    if (_.isArray(node)) {
      return node.map(el => this._parse(el, config));
    }
    if (Parser.isText(node)) {
      return node;
    }
    if (node.name) {
      node.name = node.name.toLowerCase();
    }

    const isHeadingTag = (/^h[1-6]$/).test(node.name);

    if (isHeadingTag && !node.attribs.id) {
      const textContent = utils.getTextContent(node);
      // remove the '&lt;' and '&gt;' symbols that markdown-it uses to escape '<' and '>'
      const cleanedContent = textContent.replace(/&lt;|&gt;/g, '');
      const slugifiedHeading = slugify(cleanedContent, { decamelize: false });

      let headerId = slugifiedHeading;
      const { headerIdMap } = config;
      if (headerIdMap[slugifiedHeading]) {
        headerId = `${slugifiedHeading}-${headerIdMap[slugifiedHeading]}`;
        headerIdMap[slugifiedHeading] += 1;
      } else {
        headerIdMap[slugifiedHeading] = 2;
      }

      node.attribs.id = headerId;
    }

    switch (node.name) {
    case 'md':
      node.name = 'span';
      node.children = cheerio.parseHTML(md.renderInline(cheerio.html(node.children)), true);
      break;
    case 'markdown':
      node.name = 'div';
      node.children = cheerio.parseHTML(md.render(cheerio.html(node.children)), true);
      break;
    default:
      break;
    }

    componentParser.parseComponents(node);

    if (node.children) {
      node.children.forEach((child) => {
        this._parse(child, config);
      });
    }

    componentParser.postParseComponents(node);

    // If a fixed header is applied to this page, generate dummy spans as anchor points
    if (config.fixedHeader && isHeadingTag && node.attribs.id) {
      cheerio(node).append(cheerio.parseHTML(`<span id="${node.attribs.id}" class="anchor"></span>`));
    }

    return node;
  }

  _trimNodes(node) {
    if (node.name === 'pre' || node.name === 'code') {
      return;
    }
    if (node.children) {
      for (let n = 0; n < node.children.length; n += 1) {
        const child = node.children[n];
        if (child.type === 'comment'
          || (child.type === 'text' && n === node.children.length - 1 && !/\S/.test(child.data))) {
          node.children.splice(n, 1);
          n -= 1;
        } else if (child.type === 'tag') {
          this._trimNodes(child);
        }
      }
    }
  }

  includeFile(file, content, config, additionalVariables = {}) {
    const context = {};
    context.cwf = config.cwf || file; // current working file
    context.callStack = [];
    // TODO make componentPreprocessor a class to avoid this
    config.variablePreprocessor = this.variablePreprocessor;
    return new Promise((resolve, reject) => {
      const handler = new htmlparser.DomHandler((error, dom) => {
        if (error) {
          reject(error);
          return;
        }
        const nodes = dom.map((d) => {
          let processed;
          try {
            processed = componentPreprocessor.preProcessComponent(d, context, config, this);
          } catch (err) {
            err.message += `\nError while preprocessing '${file}'`;
            logger.error(err);
            processed = utils.createErrorNode(d, err);
          }
          return processed;
        });
        resolve(cheerio.html(nodes));
      });
      const parser = new htmlparser.Parser(handler);

      const renderedContent = this.variablePreprocessor.renderPage(file, content, additionalVariables);

      const fileExt = utils.getExt(file);
      if (utils.isMarkdownFileExt(fileExt)) {
        context.source = 'md';
        parser.parseComplete(renderedContent.toString());
      } else if (fileExt === 'html') {
        context.source = 'html';
        parser.parseComplete(renderedContent);
      } else {
        const error = new Error(`Unsupported File Extension: '${fileExt}'`);
        reject(error);
      }
    });
  }

  render(content, filePath, config) {
    return new Promise((resolve, reject) => {
      const handler = new htmlparser.DomHandler((error, dom) => {
        if (error) {
          reject(error);
          return;
        }
        const nodes = dom.map((d) => {
          let parsed;
          try {
            parsed = this._parse(d, config);
          } catch (err) {
            err.message += `\nError while rendering '${filePath}'`;
            logger.error(err);
            parsed = utils.createErrorNode(d, err);
          }
          return parsed;
        });
        nodes.forEach((d) => {
          this._trimNodes(d);
        });
        resolve(cheerio.html(nodes));
      });
      const parser = new htmlparser.Parser(handler);
      const fileExt = utils.getExt(filePath);
      if (utils.isMarkdownFileExt(fileExt)) {
        const renderedContent = md.render(content);
        parser.parseComplete(renderedContent);
      } else if (fileExt === 'html') {
        parser.parseComplete(content);
      } else {
        const error = new Error(`Unsupported File Extension: '${fileExt}'`);
        reject(error);
      }
    });
  }

  static isText(node) {
    return node.type === 'text' || node.type === 'comment';
  }
}

module.exports = Parser;
