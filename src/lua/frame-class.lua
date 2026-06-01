-- frame-class.lua
-- Bootstrapped once per sandbox by registerFrameModel().
-- All __scryer_* JS helper globals are captured as upvalues then cleared.
-- Defines metatables for Frame/Texture/FontString and the global CreateFrame.

do
  -- ── Capture JS helpers as upvalues before clearing globals ─────────────────
  local _frame_new               = __scryer_frame_new
  local _frame_get_name          = __scryer_frame_get_name
  local _frame_set_id            = __scryer_frame_set_id
  local _frame_get_id            = __scryer_frame_get_id
  local _frame_get_parent        = __scryer_frame_get_parent
  local _frame_set_parent        = __scryer_frame_set_parent
  local _frame_set_size          = __scryer_frame_set_size
  local _frame_get_width         = __scryer_frame_get_width
  local _frame_get_height        = __scryer_frame_get_height
  local _frame_set_point         = __scryer_frame_set_point
  local _frame_clear_points      = __scryer_frame_clear_points
  local _frame_set_all_points    = __scryer_frame_set_all_points
  local _frame_show              = __scryer_frame_show
  local _frame_hide              = __scryer_frame_hide
  local _frame_is_shown          = __scryer_frame_is_shown
  local _frame_set_alpha         = __scryer_frame_set_alpha
  local _frame_get_alpha         = __scryer_frame_get_alpha
  local _frame_set_scale         = __scryer_frame_set_scale
  local _frame_get_scale         = __scryer_frame_get_scale
  local _frame_set_strata        = __scryer_frame_set_strata
  local _frame_get_strata        = __scryer_frame_get_strata
  local _frame_set_level         = __scryer_frame_set_level
  local _frame_get_level         = __scryer_frame_get_level
  local _frame_get_type          = __scryer_frame_get_type
  local _frame_set_script        = __scryer_frame_set_script
  local _frame_get_script        = __scryer_frame_get_script
  local _frame_hook_script       = __scryer_frame_hook_script
  local _frame_register_event    = __scryer_frame_register_event
  local _frame_unregister_event  = __scryer_frame_unregister_event
  local _frame_unregister_all    = __scryer_frame_unregister_all_events
  local _frame_set_attr          = __scryer_frame_set_attribute
  local _frame_get_attr          = __scryer_frame_get_attribute
  local _frame_child_count       = __scryer_frame_get_children_count
  local _frame_child_at          = __scryer_frame_get_child_at
  local _frame_create_texture    = __scryer_frame_create_texture
  local _frame_create_fontstring = __scryer_frame_create_fontstring
  local _btn_set_text            = __scryer_btn_set_text
  local _btn_get_text            = __scryer_btn_get_text
  local _btn_set_normal_tex      = __scryer_btn_set_normal_texture
  local _btn_enable              = __scryer_btn_enable
  local _btn_disable             = __scryer_btn_disable
  local _btn_is_enabled          = __scryer_btn_is_enabled
  local _sb_set_minmax           = __scryer_sb_set_minmax
  local _sb_get_min              = __scryer_sb_get_min
  local _sb_get_max              = __scryer_sb_get_max
  local _sb_set_value            = __scryer_sb_set_value
  local _sb_get_value            = __scryer_sb_get_value
  local _sb_set_texture          = __scryer_sb_set_texture
  local _sb_set_color            = __scryer_sb_set_color
  local _sb_set_orientation      = __scryer_sb_set_orientation
  local _tex_set_texture         = __scryer_tex_set_texture
  local _tex_get_texture         = __scryer_tex_get_texture
  local _tex_set_atlas           = __scryer_tex_set_atlas
  local _tex_set_texcoord        = __scryer_tex_set_texcoord
  local _tex_set_vertex_color    = __scryer_tex_set_vertex_color
  local _tex_set_color_tex       = __scryer_tex_set_color_texture
  local _tex_set_horiz_tile      = __scryer_tex_set_horiz_tile
  local _tex_set_vert_tile       = __scryer_tex_set_vert_tile
  local _tex_set_draw_layer      = __scryer_tex_set_draw_layer
  local _tex_set_blend           = __scryer_tex_set_blend_mode
  local _tex_set_alpha           = __scryer_tex_set_alpha
  local _tex_get_alpha           = __scryer_tex_get_alpha
  local _tex_show                = __scryer_tex_show
  local _tex_hide                = __scryer_tex_hide
  local _tex_is_shown            = __scryer_tex_is_shown
  local _tex_set_size            = __scryer_tex_set_size
  local _tex_set_point           = __scryer_tex_set_point
  local _tex_clear_points        = __scryer_tex_clear_points
  local _tex_set_all_points      = __scryer_tex_set_all_points
  local _fs_set_text             = __scryer_fs_set_text
  local _fs_get_text             = __scryer_fs_get_text
  local _fs_set_color            = __scryer_fs_set_color
  local _fs_get_color            = __scryer_fs_get_color
  local _fs_set_font             = __scryer_fs_set_font
  local _fs_set_justifyh         = __scryer_fs_set_justifyh
  local _fs_set_justifyv         = __scryer_fs_set_justifyv
  local _fs_set_alpha            = __scryer_fs_set_alpha
  local _fs_show                 = __scryer_fs_show
  local _fs_hide                 = __scryer_fs_hide
  local _fs_is_shown             = __scryer_fs_is_shown
  local _fs_set_size             = __scryer_fs_set_size
  local _fs_set_point            = __scryer_fs_set_point
  local _fs_clear_points         = __scryer_fs_clear_points
  local _fs_set_all_points       = __scryer_fs_set_all_points
  local _ui_parent_id            = __scryer_ui_parent_id
  local _event_listeners         = __scryer_event_listeners
  local _world_frame_id          = __scryer_world_frame_id
  local _apply_template          = __scryer_apply_template

  -- Shared reference cache: id → Lua table.
  local _refs = {}

  -- Script storage: { [frameId] = { [event] = { fn, fn2, ... } } }
  -- SetScript sets the chain to { fn } (or {} for nil); HookScript appends.
  -- GetScript returns handlers[1] (the primary). _fire_script calls all.
  local _scripts = {}

  -- OnUpdate frame list: frames with active OnUpdate handlers (maintained by SetScript/HookScript).
  local _update_frames     = {}
  local _update_frame_set  = {}  -- { [frameId] = true } for O(1) membership check

  -- ── _fire_script: call all handlers for (frame, event, ...) ──────────────────
  local function _fire_script(frame, event, ...)
    local id = frame.__id
    local s = _scripts[id]
    if not s then return end
    local handlers = s[event]
    if not handlers or #handlers == 0 then return end
    for i = 1, #handlers do
      local ok, err = pcall(handlers[i], frame, ...)
      if not ok then
        print("[Scryer] " .. tostring(event) .. " error: " .. tostring(err))
      end
    end
  end

  -- ── _update_frames management ────────────────────────────────────────────────
  local function _track_update(frame, has_handler)
    local id = frame.__id
    if has_handler then
      if not _update_frame_set[id] then
        _update_frame_set[id] = true
        table.insert(_update_frames, frame)
      end
    else
      if _update_frame_set[id] then
        _update_frame_set[id] = nil
        for i = #_update_frames, 1, -1 do
          if _update_frames[i].__id == id then
            table.remove(_update_frames, i)
            break
          end
        end
      end
    end
  end

  -- ── Shared: resolve a relTo argument to an ID or name ───────────────────────
  local function _relTo(rTo)
    if type(rTo) == "table" then return rTo.__id end
    if type(rTo) == "string" then return rTo end
    return nil
  end

  -- ── Texture metatable ───────────────────────────────────────────────────────
  local TextureMT = {}
  TextureMT.__index = TextureMT

  function TextureMT:SetTexture(path)        _tex_set_texture(self.__id, path)                 end
  function TextureMT:GetTexture()     return _tex_get_texture(self.__id)                        end
  function TextureMT:SetAtlas(a, sz)         _tex_set_atlas(self.__id, a, sz)                  end
  function TextureMT:GetAtlas()       return nil                                                 end
  function TextureMT:SetTexCoord(...)
    local a = {...}
    if #a == 4 then
      _tex_set_texcoord(self.__id, a[1],a[1], a[3],a[3], a[2],a[2], a[4],a[4])
    elseif #a == 8 then
      _tex_set_texcoord(self.__id, a[1],a[2], a[3],a[4], a[5],a[6], a[7],a[8])
    end
  end
  function TextureMT:SetVertexColor(r,g,b,a)  _tex_set_vertex_color(self.__id, r,g,b,a)        end
  function TextureMT:GetVertexColor()  return 1, 1, 1, 1                                        end
  function TextureMT:SetColorTexture(r,g,b,a) _tex_set_color_tex(self.__id, r,g,b,a)           end
  function TextureMT:SetBlendMode(m)           _tex_set_blend(self.__id, m)                     end
  function TextureMT:SetAlpha(a)               _tex_set_alpha(self.__id, a)                     end
  function TextureMT:GetAlpha()        return _tex_get_alpha(self.__id)                         end
  function TextureMT:Show()                    _tex_show(self.__id)                             end
  function TextureMT:Hide()                    _tex_hide(self.__id)                             end
  function TextureMT:IsShown()         return _tex_is_shown(self.__id)                          end
  function TextureMT:IsVisible()       return _tex_is_shown(self.__id)                          end
  function TextureMT:SetWidth(w)               _tex_set_size(self.__id, w, nil)                 end
  function TextureMT:SetHeight(h)              _tex_set_size(self.__id, nil, h)                 end
  function TextureMT:SetSize(w,h)              _tex_set_size(self.__id, w, h)                   end
  function TextureMT:SetPoint(p,rTo,rP,x,y)   _tex_set_point(self.__id, p, _relTo(rTo), rP, x, y) end
  function TextureMT:ClearAllPoints()          _tex_clear_points(self.__id)                     end
  function TextureMT:SetAllPoints(rTo)         _tex_set_all_points(self.__id, _relTo(rTo))      end
  function TextureMT:GetObjectType()   return "Texture"                                         end
  function TextureMT:IsObjectType(t)   return t=="Texture" or t=="Region" or t=="LayeredRegion" end
  -- Stubs: visual effects not yet modelled
  function TextureMT:SetDesaturated()  end
  function TextureMT:SetRotation()     end
  function TextureMT:SetGradient()     end
  function TextureMT:SetGradientAlpha() end
  function TextureMT:SetDrawLayer(layer, subLevel) _tex_set_draw_layer(self.__id, layer, subLevel) end
  function TextureMT:SetHorizTile(v)               _tex_set_horiz_tile(self.__id, v)               end
  function TextureMT:SetVertTile(v)                _tex_set_vert_tile(self.__id, v)                 end
  function TextureMT:SetTexelSnappingBias() end
  function TextureMT:SetSnapToPixelGrid()   end
  function TextureMT:GetWidth()        return 0 end
  function TextureMT:GetHeight()       return 0 end

  -- ── FontString metatable ────────────────────────────────────────────────────
  local FontStringMT = {}
  FontStringMT.__index = FontStringMT

  function FontStringMT:SetText(t)             _fs_set_text(self.__id, t)                      end
  function FontStringMT:GetText()      return _fs_get_text(self.__id)                           end
  function FontStringMT:SetTextColor(r,g,b,a)  _fs_set_color(self.__id, r,g,b,a)               end
  function FontStringMT:GetTextColor()
    local c = _fs_get_color(self.__id)
    if c then return c.r, c.g, c.b, c.a end
    return 1, 1, 1, 1
  end
  function FontStringMT:SetFont(path,sz,flags) _fs_set_font(self.__id, path, sz, flags)        end
  function FontStringMT:GetFont()      return nil, 0, ""                                        end
  function FontStringMT:SetJustifyH(j)         _fs_set_justifyh(self.__id, j)                  end
  function FontStringMT:GetJustifyH()  return "LEFT"                                            end
  function FontStringMT:SetJustifyV(j)         _fs_set_justifyv(self.__id, j)                  end
  function FontStringMT:GetJustifyV()  return "MIDDLE"                                          end
  function FontStringMT:SetAlpha(a)            _fs_set_alpha(self.__id, a)                     end
  function FontStringMT:GetAlpha()     return 1                                                 end
  function FontStringMT:Show()                 _fs_show(self.__id)                             end
  function FontStringMT:Hide()                 _fs_hide(self.__id)                             end
  function FontStringMT:IsShown()      return _fs_is_shown(self.__id)                          end
  function FontStringMT:IsVisible()    return _fs_is_shown(self.__id)                          end
  function FontStringMT:SetWidth(w)            _fs_set_size(self.__id, w, nil)                 end
  function FontStringMT:SetHeight(h)           _fs_set_size(self.__id, nil, h)                 end
  function FontStringMT:SetSize(w,h)           _fs_set_size(self.__id, w, h)                   end
  function FontStringMT:SetPoint(p,rTo,rP,x,y) _fs_set_point(self.__id, p, _relTo(rTo), rP, x, y) end
  function FontStringMT:ClearAllPoints()        _fs_clear_points(self.__id)                    end
  function FontStringMT:SetAllPoints(rTo)       _fs_set_all_points(self.__id, _relTo(rTo))     end
  function FontStringMT:GetObjectType() return "FontString"                                     end
  function FontStringMT:IsObjectType(t)
    return t=="FontString" or t=="Region" or t=="LayeredRegion" or t=="FontInstance"
  end
  -- Stubs: metrics not yet computed
  function FontStringMT:GetStringWidth()         return 0 end
  function FontStringMT:GetStringHeight()        return 0 end
  function FontStringMT:GetUnboundedStringWidth() return 0 end
  function FontStringMT:GetLineHeight()           return 0 end
  function FontStringMT:GetMaxLines()             return 0 end
  function FontStringMT:SetMaxLines()             end
  function FontStringMT:SetWordWrap()             end
  function FontStringMT:SetNonSpaceWrap()         end
  function FontStringMT:SetShadowColor()          end
  function FontStringMT:SetShadowOffset()         end
  function FontStringMT:SetFontObject()           end
  function FontStringMT:GetFontObject()   return nil end
  function FontStringMT:GetWidth()        return 0   end
  function FontStringMT:GetHeight()       return 0   end

  -- ── Frame metatable ─────────────────────────────────────────────────────────
  local FrameMT = {}
  FrameMT.__index = FrameMT

  function FrameMT:GetName()      return _frame_get_name(self.__id)                        end
  function FrameMT:GetID()        return _frame_get_id(self.__id)                          end
  function FrameMT:SetID(id)             _frame_set_id(self.__id, id)                      end
  function FrameMT:GetParent()
    local pid = _frame_get_parent(self.__id)
    if pid == nil then return nil end
    return _refs[pid]
  end
  function FrameMT:SetParent(p)          _frame_set_parent(self.__id, p and p.__id)        end
  function FrameMT:GetWidth()     return _frame_get_width(self.__id)  or 0                 end
  function FrameMT:GetHeight()    return _frame_get_height(self.__id) or 0                 end
  function FrameMT:SetWidth(w)
    _frame_set_size(self.__id, w, nil)
    local h = _frame_get_height(self.__id) or 0
    _fire_script(self, "OnSizeChanged", w, h)
  end
  function FrameMT:SetHeight(h)
    _frame_set_size(self.__id, nil, h)
    local w = _frame_get_width(self.__id) or 0
    _fire_script(self, "OnSizeChanged", w, h)
  end
  function FrameMT:SetSize(w, h)
    _frame_set_size(self.__id, w, h)
    _fire_script(self, "OnSizeChanged", w or 0, h or 0)
  end
  function FrameMT:GetSize()      return _frame_get_width(self.__id) or 0, _frame_get_height(self.__id) or 0 end
  function FrameMT:GetRect()      return 0, 0, _frame_get_width(self.__id) or 0, _frame_get_height(self.__id) or 0 end
  function FrameMT:GetLeft()      return 0   end
  function FrameMT:GetRight()     return _frame_get_width(self.__id)  or 0 end
  function FrameMT:GetTop()       return _frame_get_height(self.__id) or 0 end
  function FrameMT:GetBottom()    return 0   end
  function FrameMT:GetCenter()
    return (_frame_get_width(self.__id) or 0) / 2, (_frame_get_height(self.__id) or 0) / 2
  end
  function FrameMT:SetPoint(p, rTo, rP, x, y)
    _frame_set_point(self.__id, p, _relTo(rTo), rP, x, y)
  end
  function FrameMT:ClearAllPoints()      _frame_clear_points(self.__id)                    end
  function FrameMT:SetAllPoints(rTo)     _frame_set_all_points(self.__id, _relTo(rTo))     end
  function FrameMT:Show()
    _frame_show(self.__id)
    _fire_script(self, "OnShow")
  end
  function FrameMT:Hide()
    _frame_hide(self.__id)
    _fire_script(self, "OnHide")
  end
  function FrameMT:IsShown()      return _frame_is_shown(self.__id)                        end
  function FrameMT:IsVisible()    return _frame_is_shown(self.__id)                        end
  function FrameMT:SetAlpha(a)           _frame_set_alpha(self.__id, a)                    end
  function FrameMT:GetAlpha()     return _frame_get_alpha(self.__id)                       end
  function FrameMT:SetScale(s)           _frame_set_scale(self.__id, s)                    end
  function FrameMT:GetScale()     return _frame_get_scale(self.__id)                       end
  function FrameMT:GetEffectiveScale() return _frame_get_scale(self.__id)                  end
  function FrameMT:SetFrameStrata(s)     _frame_set_strata(self.__id, s)                   end
  function FrameMT:GetFrameStrata() return _frame_get_strata(self.__id) or "MEDIUM"        end
  function FrameMT:SetFrameLevel(l)      _frame_set_level(self.__id, l)                    end
  function FrameMT:GetFrameLevel() return _frame_get_level(self.__id) or 0                 end
  function FrameMT:GetObjectType() return _frame_get_type(self.__id)                       end
  function FrameMT:IsObjectType(t)
    local ot = _frame_get_type(self.__id)
    return t == ot or t == "Frame" or t == "Region" or t == "ScriptObject"
  end
  function FrameMT:GetDebugName()
    return _frame_get_name(self.__id) or ("Frame" .. tostring(self.__id))
  end
  function FrameMT:SetScript(e, fn)
    _frame_set_script(self.__id, e, fn)
    local id = self.__id
    if not _scripts[id] then _scripts[id] = {} end
    if fn ~= nil then
      _scripts[id][e] = { fn }
    else
      _scripts[id][e] = nil
    end
    if e == "OnUpdate" then _track_update(self, fn ~= nil) end
  end
  function FrameMT:GetScript(e)
    local id = self.__id
    local s = _scripts[id]
    local handlers = s and s[e]
    if handlers and #handlers > 0 then return handlers[1] end
    return nil
  end
  function FrameMT:HookScript(e, fn)
    if fn == nil then return end
    _frame_hook_script(self.__id, e, fn)
    local id = self.__id
    if not _scripts[id] then _scripts[id] = {} end
    local handlers = _scripts[id][e]
    if handlers then
      table.insert(handlers, fn)
    else
      _scripts[id][e] = { fn }
    end
    if e == "OnUpdate" then _track_update(self, true) end
  end
  function FrameMT:HasScript()   return true                                                end
  function FrameMT:RegisterEvent(e)
    _frame_register_event(self.__id, e)
    if not _event_listeners[e] then _event_listeners[e] = {} end
    local list = _event_listeners[e]
    for i = 1, #list do if list[i] == self then return end end
    table.insert(list, self)
  end
  function FrameMT:UnregisterEvent(e)
    _frame_unregister_event(self.__id, e)
    local list = _event_listeners[e]
    if list then
      for i = #list, 1, -1 do if list[i] == self then table.remove(list, i) end end
    end
  end
  function FrameMT:UnregisterAllEvents()
    _frame_unregister_all(self.__id)
    for _, list in pairs(_event_listeners) do
      for i = #list, 1, -1 do if list[i] == self then table.remove(list, i) end end
    end
  end
  function FrameMT:RegisterAllEvents()  end
  function FrameMT:SetAttribute(k,v)    _frame_set_attr(self.__id, k, v); _fire_script(self, "OnAttributeChanged", k, v) end
  function FrameMT:GetAttribute(k) return _frame_get_attr(self.__id, k)                    end
  function FrameMT:GetNumChildren()    return _frame_child_count(self.__id) end
  function FrameMT:CreateTexture(name, layer, _inherits, subLevel)
    local tid = _frame_create_texture(self.__id, name, layer or "ARTWORK", subLevel or 0)
    if tid == nil then return nil end
    local tex = setmetatable({ __id = tid }, TextureMT)
    _refs[tid] = tex
    if name then _G[name] = tex end
    return tex
  end
  function FrameMT:CreateFontString(name, layer, _inherits)
    local fid = _frame_create_fontstring(self.__id, name, layer or "OVERLAY")
    if fid == nil then return nil end
    local fs = setmetatable({ __id = fid }, FontStringMT)
    _refs[fid] = fs
    if name then _G[name] = fs end
    return fs
  end
  function FrameMT:CreateLine()   return nil end
  -- Layout / interaction stubs
  function FrameMT:Raise()                   end
  function FrameMT:Lower()                   end
  function FrameMT:SetToplevel()             end
  function FrameMT:SetClampedToScreen()      end
  function FrameMT:SetMovable()              end
  function FrameMT:SetResizable()            end
  function FrameMT:EnableMouse()             end
  function FrameMT:EnableMouseWheel()        end
  function FrameMT:EnableKeyboard()          end
  function FrameMT:SetKeyboardEnabled()      end
  function FrameMT:StartMoving()             end
  function FrameMT:StopMovingOrSizing()      end
  function FrameMT:SetUserPlaced()           end
  function FrameMT:RegisterForDrag()         end
  function FrameMT:SetHitRectInsets()        end
  function FrameMT:SetResizeBounds()         end
  function FrameMT:SetMinResize()            end
  function FrameMT:SetMaxResize()            end
  function FrameMT:IsMouseOver()    return false end
  function FrameMT:IsDragging()     return false end
  function FrameMT:IsMouseEnabled() return false end
  function FrameMT:IsKeyboardEnabled() return false end
  function FrameMT:GetChildren()
    local n = _frame_child_count(self.__id)
    local out = {}
    for i = 0, n - 1 do
      local cid = _frame_child_at(self.__id, i)
      if cid ~= nil then table.insert(out, _refs[cid]) end
    end
    return table.unpack(out)
  end
  function FrameMT:SetForbidden()      end
  function FrameMT:IsForbidden()      return false end
  function FrameMT:SetFontObject()    end
  function FrameMT:GetFontObject()    return nil end
  function FrameMT:SetNormalFontObject() end
  function FrameMT:SetHighlightFontObject() end
  function FrameMT:SetDisabledFontObject() end

  -- ── Button metatable (inherits FrameMT) ─────────────────────────────────────
  local ButtonMT = setmetatable({}, { __index = FrameMT })
  ButtonMT.__index = ButtonMT

  function ButtonMT:SetText(t)           _btn_set_text(self.__id, t)                       end
  function ButtonMT:GetText()    return _btn_get_text(self.__id)                            end
  function ButtonMT:SetNormalTexture(v)
    if type(v) == "string" then _btn_set_normal_tex(self.__id, v) end
  end
  function ButtonMT:GetNormalTexture()   return nil end
  function ButtonMT:SetPushedTexture()   end
  function ButtonMT:GetPushedTexture()   return nil end
  function ButtonMT:SetHighlightTexture() end
  function ButtonMT:GetHighlightTexture() return nil end
  function ButtonMT:SetDisabledTexture() end
  function ButtonMT:GetDisabledTexture() return nil end
  function ButtonMT:Enable()             _btn_enable(self.__id)                             end
  function ButtonMT:Disable()            _btn_disable(self.__id)                            end
  function ButtonMT:IsEnabled()  return _btn_is_enabled(self.__id)                          end
  function ButtonMT:Click()
    _fire_script(self, "OnClick", "LeftButton", false)
  end
  function ButtonMT:GetButtonState()     return "NORMAL" end
  function ButtonMT:SetButtonState()     end
  function ButtonMT:LockHighlight()      end
  function ButtonMT:UnlockHighlight()    end
  function ButtonMT:GetObjectType()      return "Button" end
  function ButtonMT:IsObjectType(t)
    return t=="Button" or t=="Frame" or t=="Region" or t=="ScriptObject"
  end

  -- ── CheckButton metatable (inherits ButtonMT) ────────────────────────────────
  local CheckButtonMT = setmetatable({}, { __index = ButtonMT })
  CheckButtonMT.__index = CheckButtonMT

  function CheckButtonMT:GetChecked()    return false end
  function CheckButtonMT:SetChecked()    end
  function CheckButtonMT:GetObjectType() return "CheckButton" end

  -- ── StatusBar metatable (inherits FrameMT) ───────────────────────────────────
  local StatusBarMT = setmetatable({}, { __index = FrameMT })
  StatusBarMT.__index = StatusBarMT

  function StatusBarMT:SetMinMaxValues(mn,mx) _sb_set_minmax(self.__id, mn, mx) end
  function StatusBarMT:GetMinMaxValues()       return _sb_get_min(self.__id), _sb_get_max(self.__id) end
  function StatusBarMT:SetValue(v)
    _sb_set_value(self.__id, v)
    _fire_script(self, "OnValueChanged", v, false)
  end
  function StatusBarMT:GetValue()      return _sb_get_value(self.__id)                              end
  function StatusBarMT:SetStatusBarTexture(v)
    if type(v) == "string" then _sb_set_texture(self.__id, v)
    elseif v == nil then _sb_set_texture(self.__id, nil) end
  end
  function StatusBarMT:GetStatusBarTexture() return nil end
  function StatusBarMT:SetStatusBarColor(r,g,b,a) _sb_set_color(self.__id, r,g,b,a) end
  function StatusBarMT:SetOrientation(o)      _sb_set_orientation(self.__id, o)                     end
  function StatusBarMT:GetOrientation()        return "HORIZONTAL"                                   end
  function StatusBarMT:GetObjectType()         return "StatusBar"                                    end
  function StatusBarMT:IsObjectType(t)
    return t=="StatusBar" or t=="Frame" or t=="Region" or t=="ScriptObject"
  end

  -- ── ScrollFrame metatable (inherits FrameMT) ─────────────────────────────────
  local ScrollFrameMT = setmetatable({}, { __index = FrameMT })
  ScrollFrameMT.__index = ScrollFrameMT

  function ScrollFrameMT:SetScrollChild()      end
  function ScrollFrameMT:GetScrollChild()      return nil end
  function ScrollFrameMT:SetHorizontalScroll() end
  function ScrollFrameMT:SetVerticalScroll()   end
  function ScrollFrameMT:GetHorizontalScroll() return 0 end
  function ScrollFrameMT:GetVerticalScroll()   return 0 end
  function ScrollFrameMT:GetScrollRange()      return 0 end
  function ScrollFrameMT:GetObjectType()       return "ScrollFrame" end

  -- ── Slider metatable (inherits FrameMT) ──────────────────────────────────────
  local SliderMT = setmetatable({}, { __index = FrameMT })
  SliderMT.__index = SliderMT

  function SliderMT:SetMinMaxValues()     end
  function SliderMT:GetMinMaxValues()     return 0, 1 end
  function SliderMT:SetValue(v)
    _fire_script(self, "OnValueChanged", v, false)
  end
  function SliderMT:GetValue()            return 0 end
  function SliderMT:SetValueStep()        end
  function SliderMT:SetOrientation()      end
  function SliderMT:SetObeyStepOnDrag()   end
  function SliderMT:GetObjectType()       return "Slider" end

  -- ── EditBox metatable (inherits FrameMT) ─────────────────────────────────────
  local EditBoxMT = setmetatable({}, { __index = FrameMT })
  EditBoxMT.__index = EditBoxMT

  function EditBoxMT:SetText(t)          _btn_set_text(self.__id, t) end
  function EditBoxMT:GetText()    return _btn_get_text(self.__id)    end
  function EditBoxMT:SetMaxLetters()     end
  function EditBoxMT:SetAutoFocus()      end
  function EditBoxMT:SetFontObject()     end
  function EditBoxMT:SetMultiLine()      end
  function EditBoxMT:SetNumeric()        end
  function EditBoxMT:GetNumber()  return 0 end
  function EditBoxMT:ClearFocus()        end
  function EditBoxMT:HasFocus()   return false end
  function EditBoxMT:SetCursorPosition() end
  function EditBoxMT:HighlightText()     end
  function EditBoxMT:GetObjectType()     return "EditBox" end

  -- ── GameTooltip metatable (inherits FrameMT) ─────────────────────────────────
  local GameTooltipMT = setmetatable({}, { __index = FrameMT })
  GameTooltipMT.__index = GameTooltipMT

  function GameTooltipMT:SetOwner()       end
  function GameTooltipMT:AddLine()        end
  function GameTooltipMT:AddDoubleLine()  end
  function GameTooltipMT:SetText()        end
  function GameTooltipMT:ClearLines()     end
  function GameTooltipMT:NumLines() return 0 end
  function GameTooltipMT:GetObjectType() return "GameTooltip" end

  -- ── Frame type → metatable map ───────────────────────────────────────────────
  local _mtByType = {
    Frame        = FrameMT,
    Button       = ButtonMT,
    CheckButton  = CheckButtonMT,
    StatusBar    = StatusBarMT,
    ScrollFrame  = ScrollFrameMT,
    Slider       = SliderMT,
    EditBox      = EditBoxMT,
    GameTooltip  = GameTooltipMT,
  }

  -- ── Bootstrap UIParent and WorldFrame Lua tables ─────────────────────────────
  UIParent   = setmetatable({ __id = _ui_parent_id   }, FrameMT)
  WorldFrame = setmetatable({ __id = _world_frame_id }, FrameMT)
  _refs[_ui_parent_id]   = UIParent
  _refs[_world_frame_id] = WorldFrame
  _G["UIParent"]   = UIParent
  _G["WorldFrame"] = WorldFrame

  -- ── CreateFrame ──────────────────────────────────────────────────────────────
  function CreateFrame(frameType, name, parent, template, _id)
    local parentId = nil
    if type(parent) == "table" and parent.__id then
      parentId = parent.__id
    elseif parent == nil then
      parentId = _ui_parent_id
    end
    local fid = _frame_new(frameType, name, parentId, template)
    if fid == nil then return nil end
    local mt = _mtByType[frameType] or FrameMT
    local frame = setmetatable({ __id = fid }, mt)
    _refs[fid] = frame
    if type(name) == "string" and #name > 0 then _G[name] = frame end
    if type(template) == "string" and #template > 0 and _apply_template then
      __scryer_tpl_frame = frame
      local _code = _apply_template(fid, template)
      if type(_code) == "string" and #_code > 0 then
        local _fn, _err = load(_code)
        if _fn then _fn()
        else print("[Scryer] template apply error: " .. tostring(_err)) end
      end
      __scryer_tpl_frame = nil
    end
    return frame
  end

  -- ── GetFrameMetatable ────────────────────────────────────────────────────────
  function GetFrameMetatable() return FrameMT end

  -- ── Mixin helpers ─────────────────────────────────────────────────────────────
  function Mixin(object, ...)
    for i = 1, select('#', ...) do
      local m = select(i, ...)
      if type(m) == "table" then
        for k, v in pairs(m) do object[k] = v end
      end
    end
    return object
  end

  function CreateFromMixins(...)
    return Mixin({}, ...)
  end

  function CreateAndInitFromMixin(mixin, ...)
    local obj = Mixin({}, mixin)
    if type(obj.Init) == "function" then obj:Init(...) end
    return obj
  end

  -- ── Miscellaneous WoW globals not in wow-api.ts ───────────────────────────────
  function nop()     end
  noop       = nop
  donothing  = nop

  -- ── Event dispatch (used by toc-runner after TOC load sequence) ──────────────
  function __scryer_fire_event(eventName, ...)
    local list = _event_listeners[eventName]
    if not list then return end
    local args = {...}
    for i = 1, #list do
      local frame = list[i]
      _fire_script(frame, "OnEvent", eventName, table.unpack(args))
    end
  end

  -- ── OnUpdate tick — called by EventEngine on each virtual clock tick ──────────
  -- elapsed is the time in seconds since the last tick.
  function __scryer_tick(elapsed)
    for i = 1, #_update_frames do
      _fire_script(_update_frames[i], "OnUpdate", elapsed)
    end
  end

  -- ── Frame-script dispatch — called by host for webview frameEvent messages ────
  -- Looks up the frame by runtimeId and fires the named script with extra args.
  function __scryer_dispatch_script(frameId, event, ...)
    local frame = _refs[frameId]
    if not frame then return end
    _fire_script(frame, event, ...)
  end

  -- ── Clear all helper globals ──────────────────────────────────────────────────
  __scryer_frame_new               = nil
  __scryer_frame_get_name          = nil
  __scryer_frame_set_id            = nil
  __scryer_frame_get_id            = nil
  __scryer_frame_get_parent        = nil
  __scryer_frame_set_parent        = nil
  __scryer_frame_set_size          = nil
  __scryer_frame_get_width         = nil
  __scryer_frame_get_height        = nil
  __scryer_frame_set_point         = nil
  __scryer_frame_clear_points      = nil
  __scryer_frame_set_all_points    = nil
  __scryer_frame_show              = nil
  __scryer_frame_hide              = nil
  __scryer_frame_is_shown          = nil
  __scryer_frame_set_alpha         = nil
  __scryer_frame_get_alpha         = nil
  __scryer_frame_set_scale         = nil
  __scryer_frame_get_scale         = nil
  __scryer_frame_set_strata        = nil
  __scryer_frame_get_strata        = nil
  __scryer_frame_set_level         = nil
  __scryer_frame_get_level         = nil
  __scryer_frame_get_type          = nil
  __scryer_frame_set_script        = nil
  __scryer_frame_get_script        = nil
  __scryer_frame_hook_script       = nil
  __scryer_frame_register_event    = nil
  __scryer_frame_unregister_event  = nil
  __scryer_frame_unregister_all_events = nil
  __scryer_frame_set_attribute     = nil
  __scryer_frame_get_attribute     = nil
  __scryer_frame_get_children_count = nil
  __scryer_frame_get_child_at      = nil
  __scryer_frame_create_texture    = nil
  __scryer_frame_create_fontstring = nil
  __scryer_btn_set_text            = nil
  __scryer_btn_get_text            = nil
  __scryer_btn_set_normal_texture  = nil
  __scryer_btn_enable              = nil
  __scryer_btn_disable             = nil
  __scryer_btn_is_enabled          = nil
  __scryer_sb_set_minmax           = nil
  __scryer_sb_get_min              = nil
  __scryer_sb_get_max              = nil
  __scryer_sb_set_value            = nil
  __scryer_sb_get_value            = nil
  __scryer_sb_set_texture          = nil
  __scryer_sb_set_color            = nil
  __scryer_sb_set_orientation      = nil
  __scryer_tex_set_texture         = nil
  __scryer_tex_get_texture         = nil
  __scryer_tex_set_atlas           = nil
  __scryer_tex_set_texcoord        = nil
  __scryer_tex_set_vertex_color    = nil
  __scryer_tex_set_color_texture   = nil
  __scryer_tex_set_horiz_tile      = nil
  __scryer_tex_set_vert_tile       = nil
  __scryer_tex_set_draw_layer      = nil
  __scryer_tex_set_blend_mode      = nil
  __scryer_tex_set_alpha           = nil
  __scryer_tex_get_alpha           = nil
  __scryer_tex_show                = nil
  __scryer_tex_hide                = nil
  __scryer_tex_is_shown            = nil
  __scryer_tex_set_size            = nil
  __scryer_tex_set_point           = nil
  __scryer_tex_clear_points        = nil
  __scryer_tex_set_all_points      = nil
  __scryer_fs_set_text             = nil
  __scryer_fs_get_text             = nil
  __scryer_fs_set_color            = nil
  __scryer_fs_get_color            = nil
  __scryer_fs_set_font             = nil
  __scryer_fs_set_justifyh         = nil
  __scryer_fs_set_justifyv         = nil
  __scryer_fs_set_alpha            = nil
  __scryer_fs_show                 = nil
  __scryer_fs_hide                 = nil
  __scryer_fs_is_shown             = nil
  __scryer_fs_set_size             = nil
  __scryer_fs_set_point            = nil
  __scryer_fs_clear_points         = nil
  __scryer_fs_set_all_points       = nil
  __scryer_ui_parent_id            = nil
  __scryer_world_frame_id          = nil
  __scryer_event_listeners         = nil
  __scryer_apply_template          = nil
end
