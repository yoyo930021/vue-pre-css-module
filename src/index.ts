import {
  NodeTransform,
  NodeTypes,
  DirectiveNode,
  AttributeNode
} from '@vue/compiler-core'
import { parseExpression } from '@babel/parser'
import { Expression, MemberExpression, Identifier } from '@babel/types'
import path from 'path'
import { interpolateName } from 'loader-utils'
import type { loader } from 'webpack'

const isBindClassAST = (node: AttributeNode | DirectiveNode): node is DirectiveNode => {
  return node.type === NodeTypes.DIRECTIVE &&
    node.name === 'bind' &&
    node.arg?.type === NodeTypes.SIMPLE_EXPRESSION &&
    node.arg.content === 'class'
}

function normalizePath(file: string) {
  return path.sep === '\\' ? file.replace(/\\/g, '/') : file;
}

const whitespace = '[\\x20\\t\\r\\n\\f]';
const unescapeRegExp = new RegExp(
  `\\\\([\\da-f]{1,6}${whitespace}?|(${whitespace})|.)`,
  'ig'
);

function unescape(str: string) {
  return str.replace(unescapeRegExp, (_, escaped, escapedWhitespace) => {
    // @ts-expect-error
    const high = `0x${escaped}` - 0x10000;

    /* eslint-disable line-comment-position */
    // NaN means non-codepoint
    // Workaround erroneous numeric interpretation of +"0x"
    // eslint-disable-next-line no-self-compare
    return high !== high || escapedWhitespace
      ? escaped
      : high < 0
      ? // BMP codepoint
        String.fromCharCode(high + 0x10000)
      : // Supplemental Plane codepoint (surrogate pair)
        // eslint-disable-next-line no-bitwise
        String.fromCharCode((high >> 10) | 0xd800, (high & 0x3ff) | 0xdc00);
    /* eslint-enable line-comment-position */
  });
}

const defaultGetLocalIdent = (
  loaderContext: loader.LoaderContext,
  localIdentName: string,
  localName: string,
  options: { context: string, hashPrefix: string, content?: string }
) => {
  const { context, hashPrefix } = options;
  const { resourcePath } = loaderContext;
  const request = normalizePath(path.relative(context, resourcePath));

  // eslint-disable-next-line no-param-reassign
  options.content = `${hashPrefix + request}\x00${localName}`;

  return interpolateName(loaderContext, localIdentName, options);
}

export const generateTransformCSSModuleClass = (
  cssModuleKeys: string[],
  loaderContext: loader.LoaderContext,
  localIdentName: string,
  getLocalIdent = defaultGetLocalIdent
): NodeTransform => {

  const isTargetStaticMemberExpression = (expAST: Expression): expAST is MemberExpression => {
    return expAST.type === 'MemberExpression' &&
      !expAST.computed &&
      expAST.object.type === 'Identifier' &&
      cssModuleKeys.includes(expAST.object.name) &&
      expAST.property.type === 'Identifier'
  }

  return node => {
    if (node.type === NodeTypes.ELEMENT) {
      node.props.forEach((p, i) => {
        if (isBindClassAST(p)) {
          if (p.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
            const expAST = parseExpression(p.exp.content)
            /**
             * :class="$style.icon" -> class="componentName_class_hash"
             */
            if (isTargetStaticMemberExpression(expAST)) {
              node.props[i] = {
                type: NodeTypes.ATTRIBUTE,
                name: 'class',
                value: {
                  type: NodeTypes.TEXT,
                  content: getLocalIdent(
                    loaderContext,
                    localIdentName,
                    unescape((expAST.property as Identifier).name),
                    { context: '/', hashPrefix: '' }
                  ),
                  loc: p.exp.loc
                },
                loc: p.loc
              }
            }
            /**
             * :class="[$style.icon, $style.disabled]" -> class="componentName_class_hash componentName_class_hash"
             */
            if (expAST.type === 'ArrayExpression' && expAST.elements.every((el) => el && el.type !== 'SpreadElement' && isTargetStaticMemberExpression(el))) {
              node.props[i] = {
                type: NodeTypes.ATTRIBUTE,
                name: 'class',
                value: {
                  type: NodeTypes.TEXT,
                  content: expAST.elements.map((el) => 
                    getLocalIdent(
                      loaderContext,
                      localIdentName,
                      // @ts-expect-error
                      unescape((el.property as Identifier).name),
                      { context: '/', hashPrefix: '' }
                    )
                  ).join(' '),
                  loc: p.exp.loc
                },
                loc: p.loc
              }
            }
          }
        }
      })
    }
  }
}
