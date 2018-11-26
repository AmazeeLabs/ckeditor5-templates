/**
 * @module template/templateediting
 */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';
import { insertElement } from '@ckeditor/ckeditor5-engine/src/conversion/downcast-converters';
import Widget from '@ckeditor/ckeditor5-widget/src/widget';
import { toWidget } from '@ckeditor/ckeditor5-widget/src/utils';
import { upcastElementToElement } from '@ckeditor/ckeditor5-engine/src/conversion/upcast-converters';

import ElementInfo from './utils/elementinfo';
import TemplateCommand from './commands/templatecommand';
import {
	downcastTemplateElement,
	getModelAttributes,
	getViewAttributes,
	upcastTemplateElement
} from './utils/conversion';
import { postfixTemplateElement, prepareTemplateElementPostfixer } from './utils/integrity';

/**
 * The template engine feature.
 *
 * For configuration examples, refer to the {@link module:template/templateediting template documentation}.
 */
export default class TemplateEditing extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ Widget ];
	}

	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'TemplateEditing';
	}

	/**
	 * @inheritDoc
	 */
	constructor( editor ) {
		super( editor );
		editor.config.define( 'templates', {} );

		/**
		 * A map with all registered {@link module:template/utils/elementinfo~ElementInfo ElementInfo} objects.
		 * @type {Object}
		 * @private
		 */
		this._elements = {};

		/**
		 * A mapping from element names to element types.
		 *
		 * @type {Object}
		 * @private
		 */
		this._typeMap = {};
	}

	/**
	 * Retrieve the template element info object for a given schema element.
	 *
	 * @param {String} name
	 * @returns {module:template/utils/elementinfo~ElementInfo}
	 */
	getElementInfo( name ) {
		return this._elements[ name ];
	}

	/**
	 * Retrieve all tempate elements with a given type.
	 *
	 * @param {String} type
	 * @return {module:template/utils/elementinfo~ElementInfo[]}
	 */
	getElementsByType( type ) {
		return Object.values( this._elements ).filter( el => el.type === type );
	}

	/**
	 * @inheritDoc
	 */
	init() {
		// Add a command for inserting a template object.
		this.editor.commands.add( 'template', new TemplateCommand( this.editor ) );

		const templates = this.editor.config.get( 'templates' );

		// Parse all template snippets and register them.
		// TODO: Allow pre-parsed snippets.
		Object.keys( templates ).forEach( name => {
			// eslint-disable-next-line no-undef
			const parser = new DOMParser();
			const dom = parser.parseFromString( templates[ name ].template, 'text/xml' ).documentElement;
			dom.setAttribute( 'ck-name', name );
			this._registerElement( dom );
		} );

		// Postfix elements to make sure a templates structure is always correct.
		this.editor.model.document.registerPostFixer( prepareTemplateElementPostfixer( this.editor, {
			types: [ 'element' ],
			postfix: postfixTemplateElement,
		} ) );

		// Allow `$text` within all elements.
		// Required until https://github.com/ckeditor/ckeditor5-engine/issues/1593 is fixed.
		// TODO: Remove this once the issue is resolved.
		this.editor.model.schema.extend( '$text', {
			allowIn: Object.keys( templates ).map( key => `ck__${ key }` ),
		} );

		// Default upcast conversion for template elements.
		this.editor.conversion.for( 'upcast' ).add( upcastTemplateElement( this.editor, {
			types: this._elementTypes,
			model: ( templateElement, viewElement, modelWriter ) => {
				return modelWriter.createElement(
					templateElement.name,
					getViewAttributes( templateElement, viewElement )
				);
			},
		} ), { priority: 'low' } );

		// Default data downcast conversions for template elements.
		this.editor.conversion.for( 'dataDowncast' ).add( downcastTemplateElement( this.editor, {
			types: this._elementTypes,
			view: ( templateElement, modelElement, viewWriter ) => {
				return viewWriter.createContainerElement(
					templateElement.tagName,
					getModelAttributes( templateElement, modelElement )
				);
			}
		} ), { priority: 'low ' } );

		// Default editing downcast conversions for template container elements without functionality.
		this.editor.conversion.for( 'editingDowncast' ).add( downcastTemplateElement( this.editor, {
			types: [ 'element' ],
			view: ( templateElement, modelElement, viewWriter ) => {
				const el = viewWriter.createContainerElement(
					templateElement.tagName,
					getModelAttributes( templateElement, modelElement )
				);
				return templateElement.parent ? el : toWidget( el, viewWriter );
			}
		} ), { priority: 'low ' } );
	}

	/**
	 * Collect all element types that have been registered.
	 *
	 * @return {String[]}
	 */
	get _elementTypes() {
		return [ ... new Set( Object.values( this._elements ).map( el => el.type ) ) ];
	}

	/**
	 * Generate a downcast handler for a specific element type.
	 *
	 * @see module:template/utils/conversion~downcastTemplateElement
	 *
	 * @param {Object} config
	 * @returns {Function}
	 */
	downcastTemplateElement( config ) {
		return dispatcher => {
			dispatcher.on( 'insert', insertElement( ( modelElement, viewWriter ) => {
				const templateElement = this._elements[ modelElement.name ];
				if ( templateElement && config.types.includes( templateElement.type ) ) {
					return config.view( templateElement, modelElement, viewWriter );
				}
			} ) );
		};
	}

	/**
	 * Generate a downcast handler for a specific element type.
	 *
	 * @see module:template/utils/conversion~upcastTemplateElement
	 *
	 * @param {Object} config
	 * @returns {Function}
	 */
	upcastTemplateElement( config ) {
		return upcastElementToElement( {
			view: viewElement => !!this._findMatchingTemplateElement( viewElement, config.types ) && { name: true },
			model: ( viewElement, modelWriter ) => config.model(
				this._findMatchingTemplateElement( viewElement, config.types ),
				viewElement,
				modelWriter
			)
		} );
	}

	_findMatchingTemplateElement( viewElement, types ) {
		return Object.values( this._elements ).filter( el => el.matches( viewElement ) && types.includes( el.type ) ).pop();
	}

	/**
	 * Register a dom element as an editor element.
	 *
	 * @param {Element} dom
	 * @param {ElementInfo} parent
	 * @private
	 */
	_registerElement( dom, parent = null ) {
		const element = new ElementInfo( dom, parent );
		this._elements[ element.name ] = element;
		this._typeMap[ element.type ] = element.name;

		// Register the element itself.
		this.editor.model.schema.register( element.name, {
			isObject: true,
			isBlock: true,
			// If this is the root element of a template, allow it in root. Else allow it only in its parent.
			allowIn: parent ? parent.name : '$root',
			// Register all know attributes.
			allowAttributes: Object.keys( element.attributes ),
		} );

		// Register all child elements.
		Array.from( dom.childNodes ).filter( node => node.nodeType === 1 )
			.map( child => this._registerElement( child, element ) );
	}
}
