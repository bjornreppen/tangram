// Point + text label rendering style

import log from '../../utils/log';
import {Style} from '../style';
import StyleParser from '../style_parser';
import gl from '../../gl/constants'; // web workers don't have access to GL context, so import all GL constants
import VertexLayout from '../../gl/vertex_layout';
import {buildQuadsForPoints} from '../../builders/points';
import Texture from '../../gl/texture';
import Geo from '../../geo';
import Vector from '../../vector';
import Collision from '../../labels/collision';
import LabelPoint from '../../labels/label_point';
import placePointsOnLine from '../../labels/point_placement';
import {TextLabels} from '../text/text_labels';
import {VIEW_PAN_SNAP_TIME} from '../../view';
import debugSettings from '../../utils/debug_settings';

let fs = require('fs');
const shaderSrc_pointsVertex = fs.readFileSync(__dirname + '/points_vertex.glsl', 'utf8');
const shaderSrc_pointsFragment = fs.readFileSync(__dirname + '/points_fragment.glsl', 'utf8');

const PLACEMENT = LabelPoint.PLACEMENT;

const pre_angles_normalize = 128 / Math.PI;
const angles_normalize = 16384 / Math.PI;
const offsets_normalize = 64;
const texcoord_normalize = 65535;

export const Points = Object.create(Style);

Points.variants = {}; // mesh variants by variant key

// texture types
const TANGRAM_POINT_TYPE_TEXTURE = 1; // style texture/sprites (assigned by user)
const TANGRAM_POINT_TYPE_LABEL = 2;   // labels (generated by rendering labels to canvas)
const TANGRAM_POINT_TYPE_SHADER = 3;  // point (drawn in shader)

// default point size in pixels
const DEFAULT_POINT_SIZE = 16;

// Mixin text label methods
Object.assign(Points, TextLabels);

Object.assign(Points, {
    name: 'points',
    built_in: true,
    vertex_shader_src: shaderSrc_pointsVertex,
    fragment_shader_src: shaderSrc_pointsFragment,
    selection: true,  // enable feature selection
    collision: true,  // style includes a collision pass
    blend: 'overlay', // overlays drawn on top of all other styles, with blending

    init(options = {}) {
        Style.init.call(this, options);

        // Vertex layout
        let attribs = [
            { name: 'a_position', size: 4, type: gl.SHORT, normalized: false },
            { name: 'a_shape', size: 4, type: gl.SHORT, normalized: false },
            { name: 'a_texcoord', size: 2, type: gl.UNSIGNED_SHORT, normalized: true },
            { name: 'a_offset', size: 2, type: gl.SHORT, normalized: false },
            { name: 'a_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true },
            { name: 'a_outline_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true, static: [0, 0, 0, 0] },
            { name: 'a_outline_edge', size: 1, type: gl.FLOAT, normalized: false, static: 0 },
            { name: 'a_selection_color', size: 4, type: gl.UNSIGNED_BYTE, normalized: true },
            { name: 'a_visible_at', size: 1, type: gl.FLOAT, normalized: false }
        ];

        this.vertex_layout = new VertexLayout(attribs);

        // Modified vertex layout for shader-drawn points
        attribs = attribs.map(x => Object.assign({}, x)); // copy attribs
        attribs.forEach(attrib => {
            // clear the static attribute value for shader points
            if (attrib.name === 'a_outline_color' || attrib.name === 'a_outline_edge') {
                attrib.static = null;
            }
        });
        this.vertex_layout_shader_point = new VertexLayout(attribs);

        // Shader defines
        this.setupDefines();

        // Include code for SDF-drawn shader points
        this.defines.TANGRAM_HAS_SHADER_POINTS = true;

        // texture types
        this.defines.TANGRAM_POINT_TYPE_TEXTURE = TANGRAM_POINT_TYPE_TEXTURE;
        this.defines.TANGRAM_POINT_TYPE_LABEL = TANGRAM_POINT_TYPE_LABEL;
        this.defines.TANGRAM_POINT_TYPE_SHADER = TANGRAM_POINT_TYPE_SHADER;

        this.collision_group_points = this.name+'-points';
        this.collision_group_text = this.name+'-text';

        this.reset();
    },

    // Setup defines common to points base and child (text) styles
    setupDefines () {
        // If we're not rendering as overlay, we need a layer attribute
        if (this.blend !== 'overlay') {
            this.defines.TANGRAM_LAYER_ORDER = true;
        }

        // Fade out when tile is zooming out, e.g. acting as proxy tiles
        this.defines.TANGRAM_FADE_ON_ZOOM_OUT = true;
        this.defines.TANGRAM_FADE_ON_ZOOM_OUT_RATE = 2; // fade at 2x, e.g. fully transparent at 0.5 zoom level away

        // Fade in (depending on tile proxy status)
        if (debugSettings.suppress_label_fade_in === true) {
            this.fade_in_time = 0;
            this.defines.TANGRAM_FADE_IN_RATE = null;
        }
        else {
            this.fade_in_time = 0.15; // time in seconds
            this.defines.TANGRAM_FADE_IN_RATE = 1 / this.fade_in_time;
        }

        // Snap points to pixel grid after panning stop
        if (debugSettings.suppress_label_snap_animation !== true) {
            this.defines.TANGRAM_VIEW_PAN_SNAP_RATE = 1 / VIEW_PAN_SNAP_TIME; // inverse time in seconds
        }

        // Show hidden labels for debugging
        if (debugSettings.show_hidden_labels === true) {
            this.defines.TANGRAM_SHOW_HIDDEN_LABELS = true;
        }
    },

    reset () {
        this.queues = {};
        this.resetText();
        this.texture_missing_sprites = {}; // track which missing sprites we've found (reduce dupe log messages)
    },

    // Override to queue features instead of processing immediately
    addFeature (feature, draw, context) {
        let tile = context.tile;
        if (tile.generation !== this.generation) {
            return;
        }

        // Point styling
        let style = {};
        style.color = this.parseColor(draw.color, context);
        style.texture = draw.texture;   // optional point texture, specified in `draw` or at style level
        style.label_texture = null;     // assigned by labelling code if needed

        // require color or texture
        if (!style.color && !style.texture) {
            return;
        }

        // optional sprite
        let sprite_info;
        if (this.hasSprites(style)) {
            sprite_info = this.parseSprite(style, draw, context);
            if (sprite_info) {
                style.texcoords = sprite_info.texcoords;
            }
            else {
                return;
            }
        }

        // point size defined explicitly, or defaults to sprite size, or generic fallback
        style.size = draw.size;
        if (!style.size) {
            style.size = (sprite_info && sprite_info.css_size) || [DEFAULT_POINT_SIZE, DEFAULT_POINT_SIZE];
        }
        else {
            style.size = StyleParser.evalCachedPointSizeProperty(draw.size, sprite_info, context);
            if (style.size == null) {
                log({ level: 'warn', once: true }, `Layer '${draw.layers[draw.layers.length-1]}': ` +
                    `'size' includes % and/or ratio-based scaling (${JSON.stringify(draw.size.value)}); ` +
                    `these can only applied to sprites, but no sprite was specified, skipping features in layer`);
                return;
            }
            else if (typeof style.size === 'number') {
                style.size = [style.size, style.size]; // convert 1d size to 2d
            }
        }

        // incorporate outline into size
        if (draw.outline) {
            style.outline_width = StyleParser.evalCachedProperty(draw.outline.width, context) || StyleParser.defaults.outline.width;
            style.outline_color = this.parseColor(draw.outline.color, context);
        }

        style.outline_edge_pct = 0;
        if (style.outline_width && style.outline_color) {
            let outline_width = style.outline_width;
            style.size[0] += outline_width;
            style.size[1] += outline_width;
            style.outline_edge_pct = outline_width / Math.min(style.size[0], style.size[1]) * 2; // UV distance at which outline starts
        }

        // size will be scaled to 16-bit signed int, so max allowed width + height of 256 pixels
        style.size[0] = Math.min(style.size[0], 256);
        style.size[1] = Math.min(style.size[1], 256);

        // Placement strategy
        style.placement = draw.placement;
        style.placement_min_length_ratio = StyleParser.evalCachedProperty(draw.placement_min_length_ratio, context);

        // Spacing parameter (in pixels) to equally space points along a line
        if (style.placement === PLACEMENT.SPACED && draw.placement_spacing) {
            style.placement_spacing = StyleParser.evalCachedProperty(draw.placement_spacing, context);
        }

        // Angle parameter (can be a number or the string "auto")
        style.angle = StyleParser.evalProperty(draw.angle, context) || 0;

        // points can be placed off the ground
        style.z = (draw.z && StyleParser.evalCachedDistanceProperty(draw.z, context)) || StyleParser.defaults.z;

        style.tile_edges = draw.tile_edges; // usually activated for debugging, or rare visualization needs

        this.computeLayout(style, feature, draw, context, tile);

        // Text styling
        let tf =
            draw.text &&
            draw.text.visible !== false && // explicitly handle `visible` property for nested text
            this.parseTextFeature(feature, draw.text, context, tile);

        if (Array.isArray(tf)) {
            tf = null; // NB: boundary labels not supported for point label attachments, should log warning
            log({ level: 'warn', once: true }, `Layer '${draw.layers[draw.layers.length-1]}': ` +
                `cannot use boundary labels (e.g. 'text_source: { left: ..., right: ... }') for 'text' labels attached to 'points'; ` +
                `provided 'text_source' value was ${JSON.stringify(draw.text.text_source)}`);
        }

        if (tf) {
            tf.layout.parent = style; // parent point will apply additional anchor/offset to text

            // Text labels have a default priority of 0.5 below their parent point (+0.5, priority is lower-is-better)
            // This can be overriden, as long as it is less than or equal to the default
            tf.layout.priority = draw.text.priority ? Math.max(tf.layout.priority, style.priority + 0.5) : (style.priority + 0.5);

            // Text labels attached to points should not be moved into tile
            // (they should stay fixed relative to the point)
            tf.layout.move_into_tile = false;

            Collision.addStyle(this.collision_group_text, tile.id);
        }

        this.queueFeature({ feature, draw, context, style, text_feature: tf }, tile); // queue the feature for later processing

        // Register with collision manager
        Collision.addStyle(this.collision_group_points, tile.id);
    },

    hasSprites (style) {
        return style.texture && Texture.textures[style.texture] && Texture.textures[style.texture].sprites;
    },

    getSpriteInfo (style, sprite) {
        let info = Texture.textures[style.texture].sprites[sprite] && Texture.getSpriteInfo(style.texture, sprite);
        if (sprite && !info) {
            // track misisng sprites (per texture)
            this.texture_missing_sprites[style.texture] = this.texture_missing_sprites[style.texture] || {};
            if (!this.texture_missing_sprites[style.texture][sprite]) { // only log each missing sprite once
                log('debug', `Style: in style '${this.name}', could not find sprite '${sprite}' for texture '${style.texture}'`);
                this.texture_missing_sprites[style.texture][sprite] = true;
            }
        }
        else if (info) {
            info.sprite = sprite;
        }
        return info;
    },

    parseSprite (style, draw, context) {
        let sprite = StyleParser.evalProperty(draw.sprite, context);
        let sprite_info = this.getSpriteInfo(style, sprite) || this.getSpriteInfo(style, draw.sprite_default);
        return sprite_info;
    },

    // Queue features for deferred processing (collect all features first so we can do collision on the whole group)
    queueFeature (q, tile) {
        if (!this.tile_data[tile.id] || !this.queues[tile.id]) {
            this.startData(tile);
        }
        this.queues[tile.id] = this.queues[tile.id] || [];
        this.queues[tile.id].push(q);
    },

    // Override
    endData (tile) {
        if (tile.canceled) {
            log('trace', `Style ${this.name}: stop tile build because tile was canceled: ${tile.key}`);
            return Promise.resolve();
        }

        let queue = this.queues[tile.id];
        delete this.queues[tile.id];

        // For each point feature, create one or more labels
        let text_objs = [];
        let point_objs = [];

        queue.forEach(q => {
            let style = q.style;
            let feature = q.feature;
            let geometry = feature.geometry;

            let feature_labels = this.buildLabels(style.size, geometry, style);
            for (let i = 0; i < feature_labels.length; i++) {
                let label = feature_labels[i];
                let point_obj = {
                    feature,
                    draw: q.draw,
                    context: q.context,
                    style,
                    label
                };
                point_objs.push(point_obj);

                if (q.text_feature) {
                    let text_obj = {
                        feature,
                        draw: q.text_feature.draw,
                        context: q.context,
                        text: q.text_feature.text,
                        text_settings_key: q.text_feature.text_settings_key,
                        layout: q.text_feature.layout,
                        point_label: label,
                        linked: point_obj   // link so text only renders when parent point is placed
                    };
                    text_objs.push(text_obj);

                    // Unless text feature is optional, create a two-way link so that parent
                    // point will only render when text is also placed
                    if (!q.draw.text.optional) {
                        point_obj.linked = text_obj; // two-way link
                    }
                }
            }
        });

        // Collide both points and text, then build features
        return Promise.
            all([
                // Points
                Collision.collide(point_objs, this.collision_group_points, tile.id).then(point_objs => {
                    point_objs.forEach(q => {
                        this.feature_style = q.style;
                        this.feature_style.label = q.label;
                        this.feature_style.linked = q.linked; // TODO: move linked into label to avoid extra prop tracking?
                        Style.addFeature.call(this, q.feature, q.draw, q.context);
                    });
                }),
                // Labels
                this.collideAndRenderTextLabels(tile, this.collision_group_text, text_objs)
            ]).then(([, { labels, texts, textures }]) => {
                // Process labels
                if (labels && texts) {
                    // Build queued features
                    labels.forEach(q => {
                        let text_settings_key = q.text_settings_key;
                        let text_info = texts[text_settings_key] && texts[text_settings_key][q.text];

                        // setup styling object expected by Style class
                        let style = this.feature_style;
                        style.label = q.label;
                        style.linked = q.linked; // TODO: move linked into label to avoid extra prop tracking?
                        style.size = text_info.size.logical_size;
                        style.angle = 0; // text attached to point is always upright
                        style.texcoords = text_info.align[q.label.align].texcoords;
                        style.label_texture = textures[text_info.align[q.label.align].texture_id];

                        Style.addFeature.call(this, q.feature, q.draw, q.context);
                    });
                }
                this.freeText(tile);

                // Finish tile mesh
                return Style.endData.call(this, tile).then(tile_data => {
                    // Attach tile-specific label atlas to mesh as a texture uniform
                    if (tile_data && textures && textures.length) {
                        tile_data.textures = tile_data.textures || [];
                        tile_data.textures.push(...textures); // assign texture ownership to tile
                    }
                    return tile_data;
                });
            });
    },

    _preprocess (draw) {
        draw.color = StyleParser.createColorPropertyCache(draw.color);
        draw.texture = (draw.texture !== undefined ? draw.texture : this.texture); // optional or default texture

        if (draw.outline) {
            draw.outline.color = StyleParser.createColorPropertyCache(draw.outline.color);
            draw.outline.width = StyleParser.createPropertyCache(draw.outline.width, StyleParser.parsePositiveNumber);
        }

        draw.z = StyleParser.createPropertyCache(draw.z, StyleParser.parseUnits);

        // Size (1d value or 2d array)
        try {
            draw.size = StyleParser.createPointSizePropertyCache(draw.size);
        }
        catch(e) {
            log({ level: 'warn', once: true }, `Layer '${draw.layers[draw.layers.length-1]}': ` +
                `${e} (${JSON.stringify(draw.size)}), skipping features in layer`);
            return null;
        }

        // Offset (2d array)
        draw.offset = StyleParser.createPropertyCache(draw.offset,
            v => Array.isArray(v) && v.map(StyleParser.parseNumber)
        );

        // Buffer (1d value or or 2d array) - must be >= 0
        draw.buffer = StyleParser.createPropertyCache(draw.buffer,
            v => (Array.isArray(v) ? v : [v, v]).map(StyleParser.parsePositiveNumber)
        );

        // Repeat rules - no repeat limitation for points by default
        draw.repeat_distance = StyleParser.createPropertyCache(draw.repeat_distance, StyleParser.parseNumber);
        if (draw.repeat_group == null) {
            draw.repeat_group = draw.layers.join('-');
        }

        // Placement strategies
        draw.placement = PLACEMENT[draw.placement && draw.placement.toUpperCase()];
        if (draw.placement == null) {
            draw.placement = PLACEMENT.VERTEX;
        }

        draw.placement_spacing = draw.placement_spacing != null ? draw.placement_spacing : 80; // default spacing
        draw.placement_spacing = StyleParser.createPropertyCache(draw.placement_spacing, StyleParser.parsePositiveNumber);

        draw.placement_min_length_ratio = draw.placement_min_length_ratio != null ? draw.placement_min_length_ratio : 1;
        draw.placement_min_length_ratio = StyleParser.createPropertyCache(draw.placement_min_length_ratio, StyleParser.parsePositiveNumber);

        if (typeof draw.angle === 'number') {
            draw.angle = draw.angle * Math.PI / 180;
        }
        else {
            draw.angle = draw.angle || 0; // angle can be a string like "auto" (use angle of geometry)
        }

        // Optional text styling
        draw.text = this.preprocessText(draw.text); // will return null if valid text styling wasn't provided
        if (draw.text) {
            draw.text.key = draw.key; // inherits parent properties
            draw.text.group = draw.group;
            draw.text.layers = draw.layers;
            draw.text.order = draw.order;
            draw.text.repeat_group = draw.text.repeat_group || draw.repeat_group;
            draw.text.anchor = draw.text.anchor || this.default_anchor;
            draw.text.optional = (typeof draw.text.optional === 'boolean') ? draw.text.optional : false; // default text to required
            draw.text.interactive = draw.text.interactive || draw.interactive; // inherits from point
        }

        return draw;
    },

    // Default to trying all anchor placements
    default_anchor: ['bottom', 'top', 'right', 'left'],

    // Compute label layout-related properties
    computeLayout (target, feature, draw, context, tile) {
        let layout = target || {};
        layout.id = feature;
        layout.units_per_pixel = tile.units_per_pixel || 1;

        // collision flag
        layout.collide = (draw.collide === false) ? false : true;

        // label anchors (point labels only)
        // label position will be adjusted in the given direction, relative to its original point
        // one of: left, right, top, bottom, top-left, top-right, bottom-left, bottom-right
        layout.anchor = draw.anchor;

        // label offset and buffer in pixel (applied in screen space)
        layout.offset = StyleParser.evalCachedProperty(draw.offset, context) || StyleParser.zeroPair;
        layout.buffer = StyleParser.evalCachedProperty(draw.buffer, context) || StyleParser.zeroPair;

        // repeat rules
        layout.repeat_distance = StyleParser.evalCachedProperty(draw.repeat_distance, context);
        if (layout.repeat_distance) {
            layout.repeat_distance *= layout.units_per_pixel;
            layout.repeat_scale = 1; // initial repeat pass in tile with full scale

            if (typeof draw.repeat_group === 'function') {
                layout.repeat_group = draw.repeat_group(context); // dynamic repeat group
            }
            else {
                layout.repeat_group = draw.repeat_group; // pre-computer repeat group
            }
        }

        // label priority (lower is higher)
        let priority = draw.priority;
        if (priority != null) {
            if (typeof priority === 'function') {
                priority = priority(context);
            }
        }
        else {
            priority = -1 >>> 0; // default to max priority value if none set
        }
        layout.priority = priority;

        return layout;
    },

    // Implements label building for TextLabels mixin
    buildTextLabels (tile, feature_queue) {
        let labels = [];
        for (let f=0; f < feature_queue.length; f++) {
            let fq = feature_queue[f];
            let text_info = this.texts[tile.id][fq.text_settings_key][fq.text];
            let size = text_info.size.collision_size;
            fq.label = new LabelPoint(fq.point_label.position, size, fq.layout);
            labels.push(fq);
        }
        return labels;
    },

    // Builds one or more point labels for a geometry
    buildLabels (size, geometry, options) {
        let labels = [];

        if (geometry.type === "Point") {
            labels.push(new LabelPoint(geometry.coordinates, size, options));
        }
        else if (geometry.type === "MultiPoint") {
            let points = geometry.coordinates;
            for (let i = 0; i < points.length; ++i) {
                let point = points[i];
                labels.push(new LabelPoint(point, size, options));
            }
        }
        else if (geometry.type === "LineString") {
            let line = geometry.coordinates;
            let point_labels = placePointsOnLine(line, size, options);
            for (let i = 0; i < point_labels.length; ++i) {
                labels.push(point_labels[i]);
            }
        }
        else if (geometry.type === "MultiLineString") {
            let lines = geometry.coordinates;
            for (let ln = 0; ln < lines.length; ln++) {
                let line = lines[ln];
                let point_labels = placePointsOnLine(line, size, options);
                for (let i = 0; i < point_labels.length; ++i) {
                    labels.push(point_labels[i]);
                }
            }
        }
        else if (geometry.type === "Polygon") {
            // Point at polygon centroid (of outer ring)
            if (options.placement === PLACEMENT.CENTROID) {
                let centroid = Geo.centroid(geometry.coordinates);
                labels.push(new LabelPoint(centroid, size, options));
            }
            // Point at each polygon vertex (all rings)
            else {
                let rings = geometry.coordinates;
                for (let ln = 0; ln < rings.length; ln++) {
                    let point_labels = placePointsOnLine(rings[ln], size, options);
                    for (let i = 0; i < point_labels.length; ++i) {
                        labels.push(point_labels[i]);
                    }
                }
            }
        }
        else if (geometry.type === "MultiPolygon") {
            if (options.placement === PLACEMENT.CENTROID) {
                let centroid = Geo.multiCentroid(geometry.coordinates);
                labels.push(new LabelPoint(centroid, size, options));
            }
            else {
                let polys = geometry.coordinates;
                for (let p = 0; p < polys.length; p++) {
                    let rings = polys[p];
                    for (let ln = 0; ln < rings.length; ln++) {
                        let point_labels = placePointsOnLine(rings[ln], size, options);
                        for (let i = 0; i < point_labels.length; ++i) {
                            labels.push(point_labels[i]);
                        }
                    }
                }
            }
        }

        return labels;
    },

    /**
     * A "template" that sets constant attibutes for each vertex, which is then modified per vertex or per feature.
     * A plain JS array matching the order of the vertex layout.
     */
    makeVertexTemplate(style, mesh) {
        let color = style.color || StyleParser.defaults.color;
        let vertex_layout = mesh.vertex_data.vertex_layout;

        // position - x & y coords will be filled in per-vertex below
        this.fillVertexTemplate(vertex_layout, 'a_position', 0, { size: 2 });
        this.fillVertexTemplate(vertex_layout, 'a_position', style.z || 0, { size: 1, offset: 2 });
        // layer order - w coord of 'position' attribute (for packing efficiency)
        this.fillVertexTemplate(vertex_layout, 'a_position', this.scaleOrder(style.order), { size: 1, offset: 3 });

        // scaling vector - (x, y) components per pixel, z = angle, w = show/hide
        this.fillVertexTemplate(vertex_layout, 'a_shape', 0, { size: 4 });
        this.fillVertexTemplate(vertex_layout, 'a_shape', style.label.layout.collide ? 0 : 1, { size: 1, offset: 3 }); // set initial label hide/show state

        // texture coords
        this.fillVertexTemplate(vertex_layout, 'a_texcoord', 0, { size: 2 });

        // offsets
        this.fillVertexTemplate(vertex_layout, 'a_offset', 0, { size: 2 });

        // color
        this.fillVertexTemplate(vertex_layout, 'a_color', Vector.mult(color, 255), { size: 4 });

        // outline (can be static or dynamic depending on style)
        if (this.defines.TANGRAM_HAS_SHADER_POINTS && mesh.variant.shader_point) {
            let outline_color = style.outline_color || StyleParser.defaults.outline.color;
            this.fillVertexTemplate(vertex_layout, 'a_outline_color', Vector.mult(outline_color, 255), { size: 4 });
            this.fillVertexTemplate(vertex_layout, 'a_outline_edge', style.outline_edge_pct || StyleParser.defaults.outline.width, { size: 1 });
        }

        // selection color
        if (this.selection) {
            this.fillVertexTemplate(vertex_layout, 'a_selection_color', Vector.mult(style.selection_color, 255), { size: 4 });
        }

        this.fillVertexTemplate(vertex_layout, 'a_visible_at', 0, { size: 1 });

        return this.vertex_template;
    },

    buildQuad(points, size, angle, angles, pre_angles, offset, offsets, texcoord_scale, curve, vertex_data, vertex_template) {
        if (size[0] <= 0 || size[1] <= 0) {
            return 0; // size must be positive
        }

        return buildQuadsForPoints(
            points,
            vertex_data,
            vertex_template,
            {
                texcoord_index: vertex_data.vertex_layout.index.a_texcoord,
                position_index: vertex_data.vertex_layout.index.a_position,
                shape_index: vertex_data.vertex_layout.index.a_shape,
                offset_index: vertex_data.vertex_layout.index.a_offset,
                offsets_index: vertex_data.vertex_layout.index.a_offsets,
                pre_angles_index: vertex_data.vertex_layout.index.a_pre_angles,
                angles_index: vertex_data.vertex_layout.index.a_angles
            },
            {
                quad: size,
                quad_normalize: 256,    // values have an 8-bit fraction
                offset,
                offsets,
                pre_angles: pre_angles,
                angle: angle * 4096,    // values have a 12-bit fraction
                angles: angles,
                curve,
                texcoord_scale,
                texcoord_normalize,
                pre_angles_normalize,
                angles_normalize,
                offsets_normalize
            }
        );
    },

    // Build quad for point sprite
    build (style, mesh, context) {
        let label = style.label;
        if (label.type === 'curved') {
            return this.buildCurvedLabel(label, style, mesh, context);
        }
        else {
            return this.buildStraightLabel(label, style, mesh, context);
        }
    },

    buildStraightLabel (label, style, mesh, context) {
        let vertex_template = this.makeVertexTemplate(style, mesh);
        let angle = label.angle || style.angle;

        let size, texcoords;
        if (label.type !== 'point') {
            size = style.size[label.type];
            texcoords = style.texcoords[label.type].texcoord;
        }
        else {
            size = style.size;
            texcoords = style.texcoords;
        }

        // setup style or label texture if applicable
        mesh.uniforms = mesh.uniforms || {};
        if (style.label_texture) {
            mesh.uniforms.u_texture = style.label_texture;
            mesh.uniforms.u_point_type = TANGRAM_POINT_TYPE_LABEL;
            mesh.uniforms.u_apply_color_blocks = false;
        }
        else if (style.texture) {
            mesh.uniforms.u_texture = style.texture;
            mesh.uniforms.u_point_type = TANGRAM_POINT_TYPE_TEXTURE;
            mesh.uniforms.u_apply_color_blocks = true;
        }
        else {
            mesh.uniforms.u_texture = Texture.default; // ensure a tetxure is always bound to avoid GL warnings ('no texture bound to unit' in Chrome)
            mesh.uniforms.u_point_type = TANGRAM_POINT_TYPE_SHADER;
            mesh.uniforms.u_apply_color_blocks = true;
        }

        let offset = label.offset;

        // TODO: instead of passing null, pass arrays with fingerprintable values
        // This value is checked in the shader to determine whether to apply curving logic
        let geom_count = this.buildQuad(
            [label.position],               // position
            size,                           // size in pixels
            angle,                          // angle in radians
            null,                           // placeholder for multiple angles
            null,                           // placeholder for multiple pre_angles
            offset,                         // offset from center in pixels
            null,                           // placeholder for multiple offsets
            texcoords,                      // texture UVs
            false,                          // if curved boolean
            mesh.vertex_data, vertex_template    // VBO and data for current vertex
        );

        // track label mesh buffer data
        const linked = (style.linked && style.linked.label.id);
        this.trackLabel(label, linked, mesh, geom_count);
    },

    buildCurvedLabel (label, style, mesh, context) {
        let vertex_template = this.makeVertexTemplate(style, mesh);
        let angle = label.angle;
        let geom_count = 0;

        // two passes for stroke and fill, where stroke needs to be drawn first (painter's algorithm)
        // this ensures strokes don't overlap on other fills

        // pass for stroke
        for (let i = 0; i < label.num_segments; i++){
            let size = style.size[label.type][i];
            let texcoord_stroke = style.texcoords_stroke[i];

            // re-point to correct label texture
            style.label_texture = style.label_textures[i];
            let mesh_data = this.getTileMesh(context.tile, this.meshVariantTypeForDraw(style));

            // add label texture uniform if needed
            mesh_data.uniforms = mesh_data.uniforms || {};
            mesh_data.uniforms.u_texture = style.label_texture;
            mesh_data.uniforms.u_point_type = TANGRAM_POINT_TYPE_LABEL;
            mesh_data.uniforms.u_apply_color_blocks = false;

            let offset = label.offset || [0,0];
            let position = label.position;

            let angles = label.angles[i];
            let offsets = label.offsets[i];
            let pre_angles = label.pre_angles[i];

            let seg_count = this.buildQuad(
                [position],                     // position
                size,                           // size in pixels
                angle,                          // angle in degrees
                angles,                         // angles per segment
                pre_angles,                     // pre_angle array (rotation applied before offseting)
                offset,                         // offset from center in pixels
                offsets,                        // offsets per segment
                texcoord_stroke,                // texture UVs for stroked text
                true,                           // if curved
                mesh_data.vertex_data, vertex_template    // VBO and data for current vertex
            );
            geom_count += seg_count;

            // track label mesh buffer data
            const linked = (style.linked && style.linked.label.id);
            this.trackLabel(label, linked, mesh, seg_count);
        }

        // pass for fill
        for (let i = 0; i < label.num_segments; i++){
            let size = style.size[label.type][i];
            let texcoord = style.texcoords[label.type][i].texcoord;

            // re-point to correct label texture
            style.label_texture = style.label_textures[i];
            let mesh_data = this.getTileMesh(context.tile, this.meshVariantTypeForDraw(style));

            // add label texture uniform if needed
            mesh_data.uniforms = mesh_data.uniforms || {};
            mesh_data.uniforms.u_texture = style.label_texture;
            mesh_data.uniforms.u_point_type = TANGRAM_POINT_TYPE_LABEL;
            mesh_data.uniforms.u_apply_color_blocks = false;

            let offset = label.offset || [0,0];
            let position = label.position;

            let angles = label.angles[i];
            let offsets = label.offsets[i];
            let pre_angles = label.pre_angles[i];

            let seg_count = this.buildQuad(
                [position],                     // position
                size,                           // size in pixels
                angle,                          // angle in degrees
                angles,                         // angles per segment
                pre_angles,                     // pre_angle array (rotation applied before offseting)
                offset,                         // offset from center in pixels
                offsets,                        // offsets per segment
                texcoord,                       // texture UVs for fill text
                true,                           // if curved
                mesh_data.vertex_data, vertex_template    // VBO and data for current vertex
            );
            geom_count += seg_count;

            // track label mesh buffer data
            const linked = (style.linked && style.linked.label.id);
            this.trackLabel(label, linked, mesh, seg_count);
        }

        return geom_count;
    },

    // track mesh data for label (byte ranges occupied by label in VBO)
    trackLabel (label, linked, mesh, geom_count) {
        if (label.layout.collide) {
            mesh.labels = mesh.labels || {};
            mesh.labels[label.id] = mesh.labels[label.id] || {
                container: {
                    label: label.toJSON(),
                    linked,
                },
                ranges: [],
                // debug: { // uncomment and pass in context for debugging
                //     id: context.feature.properties.id,
                //     name: context.feature.properties.name,
                //     props: JSON.stringify(context.feature.properties),
                //     point_type: mesh.uniforms.u_point_type
                // }
            };

            const vertex_count = geom_count * 2; // geom count is triangles: 2 triangles = 1 quad = 4 vertices
            const start = mesh.vertex_data.offset - mesh.vertex_data.stride * vertex_count; // start offset of byte range
            mesh.labels[label.id].ranges.push([
                start,
                vertex_count
            ]);
        }
    },

    // Override to pass-through to generic point builder
    buildLines (lines, style, mesh, context) {
        return this.build(style, mesh, context);
    },

    buildPoints (points, style, mesh, context) {
        return this.build(style, mesh, context);
    },

    buildPolygons (points, style, mesh, context) {
        return this.build(style, mesh, context);
    },

    // Override
    vertexLayoutForMeshVariant (variant) {
        if (variant.shader_point) {
            return this.vertex_layout_shader_point;
        }
        return this.vertex_layout;
    },

    // Override
    meshVariantTypeForDraw (draw) {
        let key = draw.label_texture || draw.texture || this.default_mesh_variant.key; // unique key by texture name
        if (Points.variants[key] == null) {
            Points.variants[key] = {
                key,
                shader_point: (key === this.default_mesh_variant.key), // is shader point
                order: (draw.label_texture ? 1 : 0) // put text on top of points (e.g. for highway shields, etc.)
            };
        }
        return Points.variants[key]; // return pre-calculated mesh variant
    },

    makeMesh (vertex_data, vertex_elements, options = {}) {
        // Add label fade time
        options = Object.assign({}, options, { fade_in_time: this.fade_in_time });
        return Style.makeMesh.call(this, vertex_data, vertex_elements, options);
    }

});
