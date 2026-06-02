// orphan guard: if the generated stub is removed, this import breaks at compile time
import "../../api-stubs/retail/C_CurveUtil.js";

// Full CreateCurve implementation for CurveConstants.lua.
// Evaluation uses linear interpolation between points.
export const C_CurveUtil = `
do
  local function CreateCurveObject()
    local curve = {}
    curve.points = {}
    curve.curveType = 0

    function curve:AddPoint(x, y)
      table.insert(self.points, {x = x, y = y})
      table.sort(self.points, function(a, b) return a.x < b.x end)
    end

    function curve:SetType(curveType)
      self.curveType = curveType
    end

    function curve:Evaluate(x)
      if #self.points == 0 then return 0 end
      if #self.points == 1 then return self.points[1].y end
      for i = 1, #self.points - 1 do
        local p1 = self.points[i]
        local p2 = self.points[i + 1]
        if x >= p1.x and x <= p2.x then
          if p2.x == p1.x then return p1.y end
          local t = (x - p1.x) / (p2.x - p1.x)
          return p1.y + (p2.y - p1.y) * t
        end
      end
      return self.points[#self.points].y
    end

    function curve:GetPoint(index)
      local p = self.points[index]
      if not p then return nil end
      return {x = p.x, y = p.y}
    end

    function curve:GetPointCount()
      return #self.points
    end

    function curve:GetPoints()
      return self.points
    end

    function curve:SetPoints(points)
      self.points = {}
      for _, p in ipairs(points) do
        self:AddPoint(p.x, p.y)
      end
    end

    function curve:RemovePoint(index)
      table.remove(self.points, index)
    end

    function curve:ClearPoints()
      self.points = {}
    end

    function curve:Copy()
      local newCurve = CreateCurveObject()
      newCurve:SetType(self.curveType)
      for _, p in ipairs(self.points) do
        newCurve:AddPoint(p.x, p.y)
      end
      return newCurve
    end

    function curve:SetToDefaults()
      self.points = {}
      self.curveType = 0
    end

    return curve
  end

  C_CurveUtil.CreateCurve = function()
    return CreateCurveObject()
  end
end
`;
