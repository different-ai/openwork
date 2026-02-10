# Tasks

> **For Claude:** REQUIRED SUB-SKILL: Use forge:executing-plans to implement this plan task-by-task.

**Change:** 1211642-spark2.0

**Goal:** 基于 Apache Spark 2.0 实现医疗门诊大数据处理模块，支持多数据源接入、数据清洗转换、实时流处理和数据输出

**Architecture:** 采用分层架构设计，包括数据源接入层、数据处理层、计算引擎层和数据输出层。使用 Spark SQL 进行批处理，Spark Streaming 进行实时处理。配置驱动开发，支持 YAML 配置文件。

**Tech Stack:** Scala 2.11, Spark 2.4.x, Maven 3.x, Hadoop 2.7.x

---

## 目录结构

```
spark-processor/
├── pom.xml
├── src/
│   ├── main/
│   │   ├── resources/
│   │   │   ├── application.yml
│   │   │   └── log4j.properties
│   │   └── scala/
│   │       └── com/winning/spark/
│   │           ├── SparkJob.scala
│   │           ├── config/
│   │           │   ├── AppConfig.scala
│   │           │   └── ConfigLoader.scala
│   │           ├── datasource/
│   │           │   ├── DataSource.scala
│   │           │   ├── SourceFactory.scala
│   │           │   ├── JsonSource.scala
│   │           │   └── CsvSource.scala
│   │           ├── processor/
│   │           │   ├── DataProcessor.scala
│   │           │   ├── DataValidator.scala
│   │           │   ├── DataCleaner.scala
│   │           │   └── DataTransformer.scala
│   │           ├── output/
│   │           │   ├── DataOutput.scala
│   │           │   └── ParquetWriter.scala
│   │           └── model/
│   │               ├── OutpatientVisit.scala
│   │               └── Prescription.scala
│   └── test/
│       └── scala/
│           └── com/winning/spark/
│               ├── SparkJobTest.scala
│               ├── DataValidatorTest.scala
│               └── DataCleanerTest.scala
└── README.md
```

---

## Task 1: 项目初始化

**Files:**
- Create: `spark-processor/pom.xml`
- Create: `spark-processor/README.md`
- Create: `spark-processor/.gitignore`

**Step 1: 创建 Maven POM 文件**

创建 pom.xml，配置 Spark 2.4.x 依赖和 Scala 插件：

```xml
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 
         http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>
    
    <groupId>com.winning</groupId>
    <artifactId>spark-processor</artifactId>
    <version>1.0.0</version>
    <packaging>jar</packaging>
    
    <properties>
        <maven.compiler.source>1.8</maven.compiler.source>
        <maven.compiler.target>1.8</maven.compiler.target>
        <scala.version>2.11.12</scala.version>
        <spark.version>2.4.8</spark.version>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>
    
    <dependencies>
        <!-- Spark Core -->
        <dependency>
            <groupId>org.apache.spark</groupId>
            <artifactId>spark-core_2.11</artifactId>
            <version>${spark.version}</version>
        </dependency>
        <!-- Spark SQL -->
        <dependency>
            <groupId>org.apache.spark</groupId>
            <artifactId>spark-sql_2.11</artifactId>
            <version>${spark.version}</version>
        </dependency>
        <!-- Spark Streaming -->
        <dependency>
            <groupId>org.apache.spark</groupId>
            <artifactId>spark-streaming_2.11</artifactId>
            <version>${spark.version}</version>
        </dependency>
        <!-- Scala Test -->
        <dependency>
            <groupId>org.scalatest</groupId>
            <artifactId>scalatest_2.11</artifactId>
            <version>3.0.8</version>
            <scope>test</scope>
        </dependency>
        <!-- SnakeYAML for Config -->
        <dependency>
            <groupId>org.yaml</groupId>
            <artifactId>snakeyaml</artifactId>
            <version>1.28</version>
        </dependency>
    </dependencies>
    
    <build>
        <plugins>
            <!-- Scala Plugin -->
            <plugin>
                <groupId>net.alchim31.maven</groupId>
                <artifactId>scala-maven-plugin</artifactId>
                <version>4.4.0</version>
                <executions>
                    <execution>
                        <goals>
                            <goal>compile</goal>
                            <goal>testCompile</goal>
                        </goals>
                    </execution>
                </executions>
            </plugin>
        </plugins>
    </build>
</project>
```

**Step 2: 创建 README.md**

**Step 3: 创建 .gitignore**

```
target/
.idea/
*.iml
*.class
*.log
.DS_Store
```

**Step 4: 验证**

Run: `cd spark-processor && mvn clean compile`
Expected: BUILD SUCCESS

---

## Task 2: 配置管理模块

**Files:**
- Create: `src/main/scala/com/winning/spark/config/AppConfig.scala`
- Create: `src/main/scala/com/winning/spark/config/ConfigLoader.scala`
- Create: `src/main/resources/application.yml`

**Step 1: 创建 AppConfig.scala**

```scala
package com.winning.spark.config

case class AppConfig(
  spark: SparkConfig,
  datasource: DatasourceConfig,
  processor: ProcessorConfig,
  output: OutputConfig
)

case class SparkConfig(
  appName: String = "WiNEX-Spark-Processor",
  master: String = "local[*]",
  parallelism: Int = 100
)

case class DatasourceConfig(
  `type`: String,
  path: String,
  options: Map[String, String] = Map.empty
)

case class ProcessorConfig(
  validation: ValidationConfig,
  cleaning: CleaningConfig,
  transformation: List[TransformRule] = Nil
)

case class ValidationConfig(
  enabled: Boolean = true,
  rules: List[ValidationRule] = Nil
)

case class CleaningConfig(
  enabled: Boolean = true,
  trimWhitespace: Boolean = true,
  removeDuplicates: Boolean = true
)

case class ValidationRule(
  field: String,
  required: Boolean = false,
  pattern: Option[String] = None,
  min: Option[Double] = None,
  max: Option[Double] = None
)

case class TransformRule(
  `type`: String,
  name: String,
  value: String
)

case class OutputConfig(
  `type`: String,
  path: String,
  mode: String = "overwrite",
  partitionBy: List[String] = Nil
)
```

**Step 2: 创建 ConfigLoader.scala**

```scala
package com.winning.spark.config

import org.yaml.snakeyaml.Yaml
import scala.io.Source
import java.io.InputStream
import scala.collection.JavaConverters._

object ConfigLoader {
  def load(configPath: String = "application.yml"): AppConfig = {
    val yaml = new Yaml()
    val inputStream = getClass.getClassLoader.getResourceAsStream(configPath)
    
    if (inputStream == null) {
      throw new RuntimeException(s"Config file not found: $configPath")
    }
    
    val configMap = yaml.load(inputStream).asInstanceOf[java.util.Map[String, Any]]
    parseConfig(configMap.asScala.toMap)
  }
  
  private def parseConfig(map: Map[String, Any]): AppConfig = {
    AppConfig(
      spark = parseSparkConfig(map.getOrElse("spark", Map.empty).asInstanceOf[java.util.Map[String, Any]].asScala.toMap),
      datasource = parseDatasourceConfig(map.getOrElse("datasource", Map.empty).asInstanceOf[java.util.Map[String, Any]].asScala.toMap),
      processor = parseProcessorConfig(map.getOrElse("processor", Map.empty).asInstanceOf[java.util.Map[String, Any]].asScala.toMap),
      output = parseOutputConfig(map.getOrElse("output", Map.empty).asInstanceOf[java.util.Map[String, Any]].asScala.toMap)
    )
  }
  
  private def parseSparkConfig(map: Map[String, Any]): SparkConfig = {
    val appMap = map.getOrElse("app", Map.empty).asInstanceOf[java.util.Map[String, Any]].asScala.toMap
    SparkConfig(
      appName = appMap.getOrElse("name", "WiNEX-Spark-Processor").toString,
      master = appMap.getOrElse("master", "local[*]").toString,
      parallelism = appMap.getOrElse("parallelism", 100).toString.toInt
    )
  }
  
  private def parseDatasourceConfig(map: Map[String, Any]): DatasourceConfig = {
    DatasourceConfig(
      `type` = map.getOrElse("type", "json").toString,
      path = map.getOrElse("path", "").toString,
      options = map.getOrElse("options", Map.empty).asInstanceOf[java.util.Map[String, String]].asScala.toMap
    )
  }
  
  private def parseProcessorConfig(map: Map[String, Any]): ProcessorConfig = {
    ProcessorConfig(
      validation = ValidationConfig(),
      cleaning = CleaningConfig(),
      transformation = Nil
    )
  }
  
  private def parseOutputConfig(map: Map[String, Any]): OutputConfig = {
    OutputConfig(
      `type` = map.getOrElse("type", "parquet").toString,
      path = map.getOrElse("path", "/tmp/output").toString,
      mode = map.getOrElse("mode", "overwrite").toString,
      partitionBy = map.getOrElse("partitionBy", List.empty).asInstanceOf[java.util.List[String]].asScala.toList
    )
  }
}
```

**Step 3: 创建 application.yml**

```yaml
spark:
  app:
    name: "WiNEX-Outpatient-ETL"
    master: "local[*]"
    parallelism: 100

datasource:
  type: "json"
  path: "/data/input/patients.json"
  options:
    multiline: "true"
    schema: "/config/patient_schema.json"

processor:
  validation:
    enabled: true
    rules: []
  cleaning:
    enabled: true
    trimWhitespace: true
    removeDuplicates: true
  transformation: []

output:
  type: "parquet"
  path: "/data/output/patients"
  mode: "overwrite"
  partitionBy:
    - "department"
```

**Step 4: 验证**

Run: `mvn test -Dtest=ConfigLoaderTest` (先创建测试)
Expected: Tests pass

---

## Task 3: 数据源接入模块

**Files:**
- Create: `src/main/scala/com/winning/spark/datasource/DataSource.scala`
- Create: `src/main/scala/com/winning/spark/datasource/SourceFactory.scala`
- Create: `src/main/scala/com/winning/spark/datasource/JsonSource.scala`
- Create: `src/main/scala/com/winning/spark/datasource/CsvSource.scala`

**Step 1: 创建 DataSource trait**

```scala
package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import org.apache.spark.sql.types.StructType
import com.winning.spark.config.DatasourceConfig

trait DataSource {
  def read(spark: SparkSession, config: DatasourceConfig): DataFrame
  def getSchema: Option[StructType] = None
}
```

**Step 2: 创建 SourceFactory**

```scala
package com.winning.spark.datasource

import com.winning.spark.config.DatasourceConfig

object SourceFactory {
  def create(config: DatasourceConfig): DataSource = {
    config.`type`.toLowerCase match {
      case "json" => new JsonSource()
      case "csv" => new CsvSource()
      case "parquet" => new ParquetSource()
      case _ => throw new IllegalArgumentException(s"Unsupported datasource type: ${config.`type`}")
    }
  }
}
```

**Step 3: 创建 JsonSource**

```scala
package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import com.winning.spark.config.DatasourceConfig

class JsonSource extends DataSource {
  override def read(spark: SparkSession, config: DatasourceConfig): DataFrame = {
    val reader = spark.read.option("multiline", "true")
    
    config.options.foreach { case (key, value) =>
      reader.option(key, value)
    }
    
    reader.json(config.path)
  }
}
```

**Step 4: 创建 CsvSource**

```scala
package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import com.winning.spark.config.DatasourceConfig

class CsvSource extends DataSource {
  override def read(spark: SparkSession, config: DatasourceConfig): DataFrame = {
    val reader = spark.read
      .option("header", "true")
      .option("inferSchema", "true")
    
    config.options.foreach { case (key, value) =>
      reader.option(key, value)
    }
    
    reader.csv(config.path)
  }
}
```

**Step 5: 创建 ParquetSource**

```scala
package com.winning.spark.datasource

import org.apache.spark.sql.{DataFrame, SparkSession}
import com.winning.spark.config.DatasourceConfig

class ParquetSource extends DataSource {
  override def read(spark: SparkSession, config: DatasourceConfig): DataFrame = {
    spark.read.parquet(config.path)
  }
}
```

---

## Task 4: 数据处理模块

**Files:**
- Create: `src/main/scala/com/winning/spark/processor/DataProcessor.scala`
- Create: `src/main/scala/com/winning/spark/processor/DataValidator.scala`
- Create: `src/main/scala/com/winning/spark/processor/DataCleaner.scala`
- Create: `src/main/scala/com/winning/spark/processor/DataTransformer.scala`

**Step 1: 创建 DataProcessor trait**

```scala
package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import com.winning.spark.config.ProcessorConfig

trait DataProcessor {
  def process(df: DataFrame, config: ProcessorConfig): DataFrame
}
```

**Step 2: 创建 DataValidator**

```scala
package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions._
import com.winning.spark.config.{ProcessorConfig, ValidationRule}

class DataValidator extends DataProcessor {
  override def process(df: DataFrame, config: ProcessorConfig): DataFrame = {
    if (!config.validation.enabled) {
      return df
    }
    
    var result = df
    
    config.validation.rules.foreach { rule =>
      result = applyRule(result, rule)
    }
    
    result
  }
  
  private def applyRule(df: DataFrame, rule: ValidationRule): DataFrame = {
    var result = df
    
    if (rule.required) {
      result = result.filter(col(rule.field).isNotNull)
    }
    
    rule.pattern.foreach { pattern =>
      result = result.filter(col(rule.field).rlike(pattern))
    }
    
    rule.min.foreach { min =>
      result = result.filter(col(rule.field) >= min)
    }
    
    rule.max.foreach { max =>
      result = result.filter(col(rule.field) <= max)
    }
    
    result
  }
}
```

**Step 3: 创建 DataCleaner**

```scala
package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions._
import com.winning.spark.config.ProcessorConfig

class DataCleaner extends DataProcessor {
  override def process(df: DataFrame, config: ProcessorConfig): DataFrame = {
    if (!config.cleaning.enabled) {
      return df
    }
    
    var result = df
    
    // Trim whitespace for string columns
    if (config.cleaning.trimWhitespace) {
      result = result.columns.foldLeft(result) { (acc, colName) =>
        val colType = acc.schema(colName).dataType
        if (colType.typeName == "string") {
          acc.withColumn(colName, trim(col(colName)))
        } else {
          acc
        }
      }
    }
    
    // Remove duplicates
    if (config.cleaning.removeDuplicates) {
      result = result.dropDuplicates()
    }
    
    result
  }
}
```

**Step 4: 创建 DataTransformer**

```scala
package com.winning.spark.processor

import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.functions._
import com.winning.spark.config.{ProcessorConfig, TransformRule}

class DataTransformer extends DataProcessor {
  override def process(df: DataFrame, config: ProcessorConfig): DataFrame = {
    config.transformation.foldLeft(df) { (acc, rule) =>
      applyTransform(acc, rule)
    }
  }
  
  private def applyTransform(df: DataFrame, rule: TransformRule): DataFrame = {
    rule.`type` match {
      case "add_column" =>
        df.withColumn(rule.name, expr(rule.value))
      case "rename" =>
        df.withColumnRenamed(rule.name, rule.value)
      case "drop" =>
        df.drop(rule.name)
      case _ => df
    }
  }
}
```

---

## Task 5: 数据模型

**Files:**
- Create: `src/main/scala/com/winning/spark/model/OutpatientVisit.scala`
- Create: `src/main/scala/com/winning/spark/model/Prescription.scala`

**Step 1: 创建 OutpatientVisit**

```scala
package com.winning.spark.model

import java.sql.Timestamp

case class OutpatientVisit(
  visitId: String,
  patientId: String,
  patientName: String,
  gender: String,
  age: Int,
  department: String,
  doctorId: String,
  visitTime: Timestamp,
  diagnosisCode: String,
  diagnosisName: String,
  totalAmount: BigDecimal,
  paymentMethod: String,
  status: String,
  createTime: Timestamp
)
```

**Step 2: 创建 Prescription**

```scala
package com.winning.spark.model

import java.sql.Timestamp

case class Prescription(
  prescriptionId: String,
  visitId: String,
  patientId: String,
  drugCode: String,
  drugName: String,
  quantity: Int,
  unitPrice: BigDecimal,
  totalPrice: BigDecimal,
  dosage: String,
  prescriptionTime: Timestamp
)
```

---

## Task 6: 数据输出模块

**Files:**
- Create: `src/main/scala/com/winning/spark/output/DataOutput.scala`
- Create: `src/main/scala/com/winning/spark/output/ParquetWriter.scala`

**Step 1: 创建 DataOutput trait**

```scala
package com.winning.spark.output

import org.apache.spark.sql.DataFrame
import com.winning.spark.config.OutputConfig

trait DataOutput {
  def write(df: DataFrame, config: OutputConfig): Unit
}
```

**Step 2: 创建 ParquetWriter**

```scala
package com.winning.spark.output

import org.apache.spark.sql.DataFrame
import com.winning.spark.config.OutputConfig

class ParquetWriter extends DataOutput {
  override def write(df: DataFrame, config: OutputConfig): Unit = {
    val writer = df.write
      .mode(config.mode)
      .format("parquet")
    
    if (config.partitionBy.nonEmpty) {
      writer.partitionBy(config.partitionBy: _*)
    }
    
    writer.save(config.path)
  }
}
```

---

## Task 7: 主程序入口

**Files:**
- Create: `src/main/scala/com/winning/spark/SparkJob.scala`
- Create: `src/main/scala/com/winning/spark/SparkSessionManager.scala`

**Step 1: 创建 SparkSessionManager**

```scala
package com.winning.spark

import org.apache.spark.sql.SparkSession
import com.winning.spark.config.SparkConfig

object SparkSessionManager {
  @volatile private var instance: Option[SparkSession] = None
  
  def getOrCreate(config: SparkConfig): SparkSession = {
    instance.synchronized {
      instance.getOrElse {
        val spark = SparkSession.builder()
          .appName(config.appName)
          .master(config.master)
          .config("spark.sql.adaptive.enabled", "true")
          .config("spark.sql.adaptive.coalescePartitions.enabled", "true")
          .config("spark.serializer", "org.apache.spark.serializer.KryoSerializer")
          .getOrCreate()
        
        instance = Some(spark)
        spark
      }
    }
  }
  
  def stop(): Unit = {
    instance.synchronized {
      instance.foreach(_.stop())
      instance = None
    }
  }
}
```

**Step 2: 创建 SparkJob 主程序**

```scala
package com.winning.spark

import com.winning.spark.config.ConfigLoader
import com.winning.spark.datasource.SourceFactory
import com.winning.spark.processor.{DataCleaner, DataTransformer, DataValidator}
import com.winning.spark.output.ParquetWriter

object SparkJob {
  def main(args: Array[String]): Unit = {
    try {
      // Load configuration
      val config = ConfigLoader.load()
      
      // Initialize Spark Session
      val spark = SparkSessionManager.getOrCreate(config.spark)
      
      println(s"Starting Spark Job: ${config.spark.appName}")
      
      // Read data from source
      val source = SourceFactory.create(config.datasource)
      val rawDF = source.read(spark, config.datasource)
      
      println(s"Loaded ${rawDF.count()} records from ${config.datasource.path}")
      
      // Process data
      val validatedDF = new DataValidator().process(rawDF, config.processor)
      val cleanedDF = new DataCleaner().process(validatedDF, config.processor)
      val transformedDF = new DataTransformer().process(cleanedDF, config.processor)
      
      println(s"Processed ${transformedDF.count()} records")
      
      // Write output
      val writer = new ParquetWriter()
      writer.write(transformedDF, config.output)
      
      println(s"Data written to ${config.output.path}")
      
    } catch {
      case e: Exception =>
        println(s"Job failed: ${e.getMessage}")
        e.printStackTrace()
        System.exit(1)
    } finally {
      SparkSessionManager.stop()
    }
  }
}
```

---

## Task 8: 单元测试

**Files:**
- Create: `src/test/scala/com/winning/spark/DataValidatorTest.scala`
- Create: `src/test/scala/com/winning/spark/DataCleanerTest.scala`
- Create: `src/test/scala/com/winning/spark/SparkJobTest.scala`

**Step 1: 创建 DataValidatorTest**

```scala
package com.winning.spark

import org.apache.spark.sql.{SparkSession, DataFrame}
import org.scalatest.{BeforeAndAfterAll, FunSuite}
import com.winning.spark.config.{ProcessorConfig, ValidationConfig, ValidationRule}
import com.winning.spark.processor.DataValidator

class DataValidatorTest extends FunSuite with BeforeAndAfterAll {
  private var spark: SparkSession = _
  
  override def beforeAll(): Unit = {
    spark = SparkSession.builder()
      .appName("DataValidatorTest")
      .master("local[2]")
      .getOrCreate()
  }
  
  override def afterAll(): Unit = {
    if (spark != null) {
      spark.stop()
    }
  }
  
  test("should filter records with null values when required") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三", 25),
      (null, "李四", 30),
      ("P003", null, 35)
    ).toDF("patient_id", "name", "age")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(
        enabled = true,
        rules = List(ValidationRule("patient_id", required = true))
      ),
      cleaning = null
    )
    
    val validator = new DataValidator()
    val result = validator.process(data, config)
    
    assert(result.count() == 2)
    assert(result.filter(col("patient_id").isNull).count() == 0)
  }
  
  test("should validate field pattern") {
    import spark.implicits._
    
    val data = Seq(
      ("P0000001", "张三"),
      ("INVALID", "李四"),
      ("P1234567", "王五")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(
        enabled = true,
        rules = List(ValidationRule("patient_id", pattern = Some("^P\\d{7}$")))
      ),
      cleaning = null
    )
    
    val validator = new DataValidator()
    val result = validator.process(data, config)
    
    assert(result.count() == 2)
  }
}
```

**Step 2: 创建 DataCleanerTest**

```scala
package com.winning.spark

import org.apache.spark.sql.SparkSession
import org.scalatest.{BeforeAndAfterAll, FunSuite}
import com.winning.spark.config.{ProcessorConfig, CleaningConfig, ValidationConfig}
import com.winning.spark.processor.DataCleaner

class DataCleanerTest extends FunSuite with BeforeAndAfterAll {
  private var spark: SparkSession = _
  
  override def beforeAll(): Unit = {
    spark = SparkSession.builder()
      .appName("DataCleanerTest")
      .master("local[2]")
      .getOrCreate()
  }
  
  override def afterAll(): Unit = {
    if (spark != null) {
      spark.stop()
    }
  }
  
  test("should trim whitespace from string columns") {
    import spark.implicits._
    
    val data = Seq(
      ("  P001  ", " 张三 "),
      ("P002", "李四")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(),
      cleaning = CleaningConfig(enabled = true, trimWhitespace = true)
    )
    
    val cleaner = new DataCleaner()
    val result = cleaner.process(data, config)
    
    val firstRow = result.filter(col("patient_id") === "P001").collect()(0)
    assert(firstRow.getString(1) == "张三") // trimmed
  }
  
  test("should remove duplicate records") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三"),
      ("P001", "张三"),
      ("P002", "李四")
    ).toDF("patient_id", "name")
    
    val config = ProcessorConfig(
      validation = ValidationConfig(),
      cleaning = CleaningConfig(enabled = true, removeDuplicates = true)
    )
    
    val cleaner = new DataCleaner()
    val result = cleaner.process(data, config)
    
    assert(result.count() == 2)
  }
}
```

**Step 3: 创建 SparkJobTest**

```scala
package com.winning.spark

import org.apache.spark.sql.SparkSession
import org.scalatest.{BeforeAndAfterAll, FunSuite}

class SparkJobTest extends FunSuite with BeforeAndAfterAll {
  private var spark: SparkSession = _
  
  override def beforeAll(): Unit = {
    spark = SparkSession.builder()
      .appName("SparkJobTest")
      .master("local[2]")
      .getOrCreate()
  }
  
  override def afterAll(): Unit = {
    if (spark != null) {
      spark.stop()
    }
  }
  
  test("SparkSession should be initialized") {
    assert(spark != null)
    assert(spark.sparkContext.appName == "SparkJobTest")
  }
  
  test("should create DataFrame from sequence") {
    import spark.implicits._
    
    val data = Seq(
      ("P001", "张三", 25),
      ("P002", "李四", 30)
    ).toDF("id", "name", "age")
    
    assert(data.count() == 2)
    assert(data.columns.length == 3)
  }
}
```

---

## Task 9: 集成测试和验证

**Step 1: 运行所有测试**

Run: `mvn clean test`
Expected: All tests pass

**Step 2: 编译打包**

Run: `mvn clean package -DskipTests`
Expected: spark-processor-1.0.0.jar created in target/

**Step 3: 验证代码覆盖率**

Run: `mvn scoverage:report` (if scoverage plugin configured)
Expected: Coverage > 80%

---

## Execution Summary

Total Tasks: 9  
Estimated Time: 2-3 hours  
Key Deliverables:
1. Complete Spark 2.0 module with Maven build
2. DataSource, Processor, Output layers
3. Unit tests with >80% coverage
4. Configuration-driven architecture

Next: After all tasks complete, use forge:finishing-a-development-branch skill to commit and create PR.
