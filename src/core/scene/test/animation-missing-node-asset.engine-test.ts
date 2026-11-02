/*---------------------------------------------------------------------------------------------
 *  Copyright (c) SUD. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { join } from 'path';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import Module from 'module';
import { TestGlobalEnv } from '../../../tests/global-env';

// 使用 --testMatch '**/animation-missing-node-asset.engine-test.ts' 在独立进程中运行
const engineModules = [
    'cc', 'cc/editor/populate-internal-constants', 'cc/editor/serialization',
    'cc/editor/new-gen-anim', 'cc/editor/embedded-player', 'cc/editor/reflection-probe',
    'cc/editor/lod-group-utils', 'cc/editor/material', 'cc/editor/2d-misc',
    'cc/editor/offline-mappings', 'cc/editor/custom-pipeline', 'cc/editor/animation-clip-migration',
    'cc/editor/exotic-animation', 'cc/editor/color-utils',
];

describe('Missing-node resource keyframes with the real engine', () => {
    let engine: typeof import('cc');
    let propertyCurves: typeof import('../scene-process/service/animation/property-curve');
    let normalizer: typeof import('../scene-process/service/animation/operation-normalizer');
    let writablePath: string;
    let restoreModuleHooks: (() => void) | undefined;

    beforeAll(async () => {
        jest.resetModules();
        const moduleHooks = Module as typeof Module & { _load: unknown; _resolveFilename: unknown };
        const { _load, _resolveFilename } = moduleHooks;
        restoreModuleHooks = () => {
            moduleHooks._load = _load;
            moduleHooks._resolveFilename = _resolveFilename;
        };
        const { EngineLoader } = await import('cc/loader.js');
        engineModules.forEach(module => {
            jest.doMock(module, () => EngineLoader.getEngineModuleById(module), { virtual: true });
        });
        writablePath = await mkdtemp(join(tmpdir(), 'cocos-animation-missing-node-'));
        const { Engine } = await import('../../engine');
        await Engine.importEditorExtensions();
        const { default: preload } = await import('cc/preload');
        await preload({
            engineRoot: TestGlobalEnv.engineRoot,
            engineDev: join(TestGlobalEnv.engineRoot, 'bin/.cache/dev-cli'),
            writablePath,
            requiredModules: engineModules,
        });
        await Engine.initEditorExtensions();
        engine = await import('cc');
        propertyCurves = await import('../scene-process/service/animation/property-curve');
        normalizer = await import('../scene-process/service/animation/operation-normalizer');
    });

    afterAll(async () => {
        // 引擎加载器会修改 Node 的全局模块钩子，测试结束后恢复原有钩子
        restoreModuleHooks?.();
        if (writablePath) {
            await rm(writablePath, { recursive: true, force: true });
        }
    });

    const keyTypes = ['createPropertyKey', 'updatePropertyKey'] as const;
    const cases = keyTypes.flatMap(type => ['Missing', 'Root/Missing'].flatMap(nodePath =>
        [false, true].map(clearKeys => ({ type, nodePath, clearKeys })),
    ));

    it.each(cases)(
        '$type loads the referenced SpriteFrame: path=$nodePath, cleared=$clearKeys',
        async ({ type, nodePath, clearKeys }) => {
            const rootNode = new engine.Node('Root');
            const clip = new engine.AnimationClip();
            const track = new engine.animation.ObjectTrack();
            track.path = new engine.animation.TrackPath()
                .toHierarchy('Missing')
                .toComponent('cc.Sprite')
                .toProperty('spriteFrame');
            const original = new engine.SpriteFrame();
            const referenced = new engine.SpriteFrame();
            const texture = new engine.Texture2D();
            referenced.texture = texture;
            Object.assign(referenced, { _uuid: 'missing-node-referenced-sprite-frame' });
            track.channel.curve.assignSorted([[0, original]]);
            clip.addTrack(track);
            engine.assetManager.assets.add(referenced.uuid, referenced);

            try {
                if (clearKeys) {
                    // 先从已有关键帧恢复并缓存类型，再模拟清空轨道后写入
                    const curves = propertyCurves.dumpPropertyCurves(clip);
                    expect(curves[0]?.type?.value).toBe('cc.SpriteFrame');
                    track.channel.curve.assignSorted([]);
                }

                const context = {
                    currentClipUuid: clip.uuid,
                    clip,
                    rootNode,
                    rootPath: 'Root',
                    queryPropertyValueAtFrame: jest.fn(),
                };
                const operation = await normalizer.normalizeAnimationOperation({
                    type,
                    clipUuid: clip.uuid,
                    nodePath,
                    propKey: 'cc.Sprite.spriteFrame',
                    frame: type === 'createPropertyKey' ? 30 : 0,
                    value: { uuid: referenced.uuid },
                }, context);
                if (!('type' in operation)) {
                    throw new Error(operation.reason);
                }
                if (operation.type !== type) {
                    throw new Error(`Unexpected operation: ${operation.type}`);
                }
                const write = type === 'createPropertyKey'
                    ? propertyCurves.createPropertyKey
                    : propertyCurves.updatePropertyKey;
                expect(write(clip, context, operation)).toBe(true);
                const values = Array.from(track.channel.curve.values());
                const stored = values[values.length - 1];
                expect(stored === referenced).toBe(true);
                expect(
                    stored instanceof engine.SpriteFrame && stored.texture === texture,
                ).toBe(true);
                expect(context.queryPropertyValueAtFrame).not.toHaveBeenCalled();
            } finally {
                engine.assetManager.assets.remove(referenced.uuid);
                rootNode.destroy();
                original.destroy();
                referenced.destroy();
                texture.destroy();
                clip.destroy();
                engine.CCObject._deferredDestroy();
            }
        },
    );
});
