# Spark 2.0 医疗门诊大数据处理模块 - 技术设计

**TFS Work Item:** #1211642  
**Change:** spark2.0开发  
**Version:** 1.0  
**Status:** Draft  

## 1. 架构设计

### 1.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Spark 2.0 大数据处理平台                             │
├─────────────────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │   DataSource │  │   DataSource │  │   DataSource │  │   DataSource │    │
│  │    (JSON)    │  │    (CSV)     │  │   (JDBC)     │  │   (Kafka)    │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                 │                 │                 │             │
│         └─────────────────┴─────────────────┴─────────────────┘             │
│                                    │                                        │
│                         ┌──────────▼──────────┐                            │
│                         │  DataSource Layer   │                            │
│                         │   (SourceFactory)   │                            │
│                         └──────────┬──────────┘                            │
│                                    │                                        │
│  ┌─────────────────────────────────▼────────────────────────────────────┐  │
│  │                     Data Processing Layer                             │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │  │
│  │  │DataValidator │  │DataCleaner   │  │DataTransformer│              │  │
│  │  │  (Schema)    │  │  (Rules)     │  │   (UDF/UDAF)  │              │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│                         ┌──────────▼──────────┐                            │
│                         │   Compute Engine    │                            │
│                         │  (Spark SQL/RDD)    │                            │
│                         └──────────┬──────────┘                            │
│                                    │                                        │
│  ┌─────────────────────────────────▼────────────────────────────────────┐  │
│  │                      Data Output Layer                                │  │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐              │  │
│  │  │   Parquet    │  │     Hive     │  │     HDFS     │              │  │
│  │  │   Storage    │  │   Warehouse  │  │    Files     │              │  │
│  │  └──────────────┘  └──────────────┘  └──────────────┘              │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 模块划分

| 模块 | 职责 | 核心类 |
|------|------|--------|
| **spark-core** | SparkSession管理、配置加载 | SparkSessionManager, AppConfig |
| **datasource** | 数据源接入 | SourceFactory, JsonSource, CsvSource, JdbcSource, KafkaSource |
| **processor** | 数据处理逻辑 | DataValidator, DataCleaner, DataTransformer |
| **output** | 数据输出 | OutputWriter, ParquetWriter, HiveWriter |
| **streaming** | 流处理 | StreamingProcessor, WindowAggregator |
| **monitor** | 监控告警 | MetricsCollector, JobMonitor |

## 2. 接口设计

### 2.1 核心API

```scala
// 主入口类
trait SparkJob {
  def run(args: Array[String]): Unit
  def validateConfig(config: AppConfig): Boolean
}

// 数据源接口
trait DataSource {
  def read(spark: SparkSession, config: SourceConfig): DataFrame
  def getSchema: Option[StructType]
}

// 处理器接口
trait DataProcessor {
  def process(df: DataFrame, config: ProcessConfig): DataFrame
}

// 输出接口
trait DataOutput {
  def write(df: DataFrame, config: OutputConfig): Unit
}
```

### 2.2 配置结构

```yaml
# application.yml
spark:
  app:
    name: "WiNEX-Outpatient-ETL"
    master: "local[*]"
  
  datasource:
    type: "json"
    path: "/data/input/patients.json"
    schema: "/config/patient_schema.json"
  
  processor:
    validation:
      enabled: true
      rules:
        - field: "patient_id"
          required: true
          pattern: "^P\\d{8}$"
        - field: "age"
          required: true
          min: 0
          max: 150
    cleaning:
      enabled: true
      trimWhitespace: true
      removeDuplicates: true
    transformation:
      - type: "add_column"
        name: "process_date"
        value: "current_date()"
      - type: "hash"
        field: "phone"
        method: "sha256"
  
  output:
    type: "parquet"
    path: "/data/output/patients"
    mode: "overwrite"
    partitionBy: ["department", "process_date"]
```

## 3. 数据模型

### 3.1 门诊就诊数据模型

```scala
case class OutpatientVisit(
  visitId: String,           // 就诊流水号
  patientId: String,         // 患者ID
  patientName: String,       // 患者姓名（脱敏）
  gender: String,            // 性别
  age: Int,                  // 年龄
  department: String,        // 就诊科室
  doctorId: String,          // 医生ID
  visitTime: Timestamp,      // 就诊时间
  diagnosisCode: String,     // 诊断编码ICD-10
  diagnosisName: String,     // 诊断名称
  totalAmount: BigDecimal,   // 总费用
  paymentMethod: String,     // 支付方式
  status: String,            // 就诊状态
  createTime: Timestamp      // 记录创建时间
)
```

### 3.2 处方数据模型

```scala
case class Prescription(
  prescriptionId: String,    // 处方ID
  visitId: String,           // 就诊流水号
  patientId: String,         // 患者ID
  drugCode: String,          // 药品编码
  drugName: String,          // 药品名称
  quantity: Int,             // 数量
  unitPrice: BigDecimal,     // 单价
  totalPrice: BigDecimal,    // 总价
  dosage: String,            // 用法用量
  prescriptionTime: Timestamp // 处方时间
)
```

## 4. 技术实现细节

### 4.1 SparkSession 管理

```scala
object SparkSessionManager {
  private var sparkSession: Option[SparkSession] = None
  
  def getOrCreate(config: SparkConfig): SparkSession = {
    sparkSession.getOrElse {
      val spark = SparkSession.builder()
        .appName(config.appName)
        .master(config.master)
        .config("spark.sql.adaptive.enabled", "true")
        .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
        .config("spark.serializer", "org.apache.spark.serializer.KryoSerializer")
        .getOrCreate()
      
      sparkSession = Some(spark)
      spark
    }
  }
  
  def stop(): Unit = {
    sparkSession.foreach(_.stop())
    sparkSession = None
  }
}
```

### 4.2 数据验证器实现

```scala
class DataValidator(config: ValidationConfig) extends DataProcessor {
  override def process(df: DataFrame, processConfig: ProcessConfig): DataFrame = {
    var result = df
    
    // Schema验证
    if (config.schemaValidation) {
      result = validateSchema(result, config.schema)
    }
    
    // 字段值验证
    config.rules.foreach { rule =>
      result = validateField(result, rule)
    }
    
    result
  }
  
  private def validateField(df: DataFrame, rule: ValidationRule): DataFrame = {
    rule match {
      case RequiredRule(field) =>
        df.filter(col(field).isNotNull)
      case PatternRule(field, pattern) =>
        df.filter(col(field).rlike(pattern))
      case RangeRule(field, min, max) =>
        df.filter(col(field) >= min && col(field) <= max)
    }
  }
}
```

### 4.3 流处理实现

```scala
class StreamingProcessor(spark: SparkSession, config: StreamingConfig) {
  def start(): StreamingQuery = {
    val streamDF = spark.readStream
      .format(config.sourceType)
      .option("kafka.bootstrap.servers", config.kafkaServers)
      .option("subscribe", config.topic)
      .option("startingOffsets", "latest")
      .load()
    
    // 解析JSON数据
    val parsedDF = streamDF
      .select(from_json(col("value").cast("string"), schema).as("data"))
      .select("data.*")
    
    // 窗口聚合
    val windowedCounts = parsedDF
      .withWatermark("timestamp", config.watermark)
      .groupBy(
        window(col("timestamp"), config.windowDuration),
        col("department")
      )
      .count()
    
    // 输出到控制台或Kafka
    windowedCounts.writeStream
      .outputMode("append")
      .format(config.outputType)
      .option("truncate", "false")
      .start()
  }
}
```

## 5. 测试策略

### 5.1 单元测试

```scala
class DataValidatorTest extends FunSuite with BeforeAndAfterAll {
  private var spark: SparkSession = _
  
  override def beforeAll(): Unit = {
    spark = SparkSession.builder()
      .appName("Test")
      .master("local[2]")
      .getOrCreate()
  }
  
  test("should filter records with null patient_id") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三", 25),
      (null, "李四", 30),
      ("P003", "王五", 35)
    ).toDF("patient_id", "name", "age")
    
    val validator = new DataValidator(ValidationConfig(
      rules = Seq(RequiredRule("patient_id"))
    ))
    
    val result = validator.process(data, ProcessConfig())
    assert(result.count() == 2)
  }
}
```

### 5.2 集成测试

- 端到端数据流测试
- 数据源连接测试
- 输出结果验证

## 6. 性能考虑

### 6.1 优化策略

| 优化点 | 实现方式 | 预期收益 |
|--------|----------|----------|
| 数据分区 | 按科室+日期分区 | 查询性能提升3-5倍 |
| 列式存储 | Parquet格式 | 存储减少70%，查询快10倍 |
| 广播变量 | 小表广播Join | 减少Shuffle，提升50% |
| 数据倾斜处理 | Salting技术 | 解决热点问题 |
| 动态资源分配 | Spark动态分配 | 节省30%资源 |

### 6.2 资源配置建议

```scala
// Executor配置
spark.executor.instances=10
spark.executor.cores=4
spark.executor.memory=8g
spark.executor.memoryOverhead=1g

// Driver配置
spark.driver.memory=4g
spark.driver.maxResultSize=2g

// Shuffle配置
spark.sql.shuffle.partitions=200
spark.default.parallelism=100
```

## 7. 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| Spark与Hadoop版本不兼容 | 中 | 高 | 提前在测试环境验证，使用兼容版本矩阵 |
| 内存溢出 | 高 | 高 | 合理配置资源，监控内存使用，设置溢出策略 |
| 数据倾斜 | 中 | 中 | 预处理数据分布，使用Salting技术 |
| 网络不稳定 | 低 | 中 | 断点续传，重试机制，幂等设计 |

## 8. 时间估算

| 阶段 | 工时 | 里程碑 |
|------|------|--------|
| 环境搭建 | 2人天 | Spark环境就绪 |
| 数据接入层 | 3人天 | 支持5种数据源 |
| 数据处理层 | 5人天 | 清洗、转换规则完成 |
| 流处理层 | 3人天 | 实时统计功能 |
| 输出层 | 2人天 | 多格式输出支持 |
| 测试优化 | 3人天 | 单元测试覆盖>80% |
| **总计** | **18人天 (~4人周)** | - |

## 9. 后续迭代

- **V1.1**: 机器学习集成（患者流失预测）
- **V1.2**: 实时风控模块
- **V1.3**: 数据血缘追踪
- **V2.0**: 迁移至Spark 3.x
